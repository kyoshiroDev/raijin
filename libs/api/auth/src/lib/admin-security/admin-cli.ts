import { Injectable, Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiConfigModule, loadConfig, type AppConfig } from '@raijin/api-core';
import { ApiPrismaModule, PrismaService } from '@raijin/api-prisma';
import { emailSchema } from '@raijin/shared-contracts';
import { AuditService } from '../audit/audit.service';
import { normalizeEmail } from '../services/email-normalizer';

/**
 * Outils d'administration en ligne de commande (docs/ARCHITECTURE.md §14.2, §14.3), **jamais depuis l'interface** :
 * - `pnpm nx run api:make-admin --email=… [--revoke]` : attribue (ou retire) le rôle ADMIN ;
 * - `pnpm nx run api:admin-reset-2fa --email=…` : efface la 2FA (téléphone et codes de secours perdus).
 * En production : `docker compose exec api node cli.js make-admin --email=…` (lancé par l'utilisateur, docs/DEPLOY.md).
 * Chaque changement est audité (`actorKind: cli`). Aucune sortie ne contient de secret.
 */

export type AdminCliCommand = 'make-admin' | 'admin-reset-2fa';

export interface AdminCliArgs {
  readonly command: AdminCliCommand;
  readonly email: string;
  readonly revoke: boolean;
}

export type AdminCliOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

export const ADMIN_CLI_USAGE = [
  'Usage :',
  '  pnpm nx run api:make-admin --email=ton@email [--revoke]',
  '  pnpm nx run api:admin-reset-2fa --email=ton@email',
].join('\n');

/** Lit `<commande> --email=… [--revoke]` (aussi `--email …`). `null` si invalide. */
export function parseAdminCliArgs(argv: readonly string[]): AdminCliArgs | { error: string } {
  const [command, ...rest] = argv;
  if (command !== 'make-admin' && command !== 'admin-reset-2fa') return { error: 'Commande inconnue.' };
  let email: string | undefined;
  let revoke = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? '';
    if (arg === '--revoke' || arg === '--revoke=true') revoke = true;
    else if (arg.startsWith('--email=')) email = arg.slice('--email='.length);
    else if (arg === '--email') email = rest[++index];
    else return { error: `Option inconnue : ${arg.slice(0, 40)}` };
  }
  if (revoke && command !== 'make-admin') return { error: '--revoke ne s’applique qu’à make-admin.' };
  const parsed = emailSchema.safeParse(email ?? '');
  if (!parsed.success) return { error: 'Adresse e-mail invalide (--email=ton@email).' };
  return { command, email: parsed.data, revoke };
}

@Injectable()
export class AdminCliService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  run(args: AdminCliArgs, now: Date = new Date()): Promise<AdminCliOutcome> {
    if (args.command === 'admin-reset-2fa') return this.resetTwoFactor(args.email);
    return args.revoke ? this.revokeAdmin(args.email, now) : this.makeAdmin(args.email);
  }

  private findUser(email: string) {
    return this.prisma.user.findUnique({
      where: { emailNormalized: normalizeEmail(email) },
      select: { id: true, role: true, emailVerifiedAt: true, suspendedAt: true },
    });
  }

  /** Compte existant, e-mail vérifié, non suspendu. */
  async makeAdmin(email: string): Promise<AdminCliOutcome> {
    const user = await this.findUser(email);
    if (!user) return { ok: false, message: 'Aucun compte avec cette adresse.' };
    if (!user.emailVerifiedAt) return { ok: false, message: 'Adresse non vérifiée : confirme d’abord l’e-mail du compte.' };
    if (user.suspendedAt) return { ok: false, message: 'Compte suspendu : réactive-le avant de lui donner le rôle admin.' };
    if (user.role === 'ADMIN') return { ok: true, message: 'Ce compte est déjà admin (aucun changement).' };
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
      await this.audit.recordInTx(tx, {
        action: 'admin.role_granted',
        actorKind: 'cli',
        actorId: null,
        userId: user.id,
        metadata: { before: { role: 'USER' }, after: { role: 'ADMIN' } },
      });
    });
    return {
      ok: true,
      message: 'Rôle admin attribué. À la prochaine ouverture de /admin, active la double authentification (application TOTP).',
    };
  }

  /** Retire le rôle : toutes les sessions du compte sont révoquées (reconnexion avec le rôle utilisateur). */
  async revokeAdmin(email: string, now: Date): Promise<AdminCliOutcome> {
    const user = await this.findUser(email);
    if (!user) return { ok: false, message: 'Aucun compte avec cette adresse.' };
    if (user.role !== 'ADMIN') return { ok: true, message: 'Ce compte n’est pas admin (aucun changement).' };
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { role: 'USER' } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'admin_revoked' } });
      await this.audit.recordInTx(tx, {
        action: 'admin.role_revoked',
        actorKind: 'cli',
        actorId: null,
        userId: user.id,
        metadata: { before: { role: 'ADMIN' }, after: { role: 'USER' } },
      });
    });
    return { ok: true, message: 'Rôle admin retiré, sessions du compte révoquées.' };
  }

  /** Efface le secret TOTP et les codes de secours ; les sessions admin retombent à « non vérifiées ». */
  async resetTwoFactor(email: string): Promise<AdminCliOutcome> {
    const user = await this.findUser(email);
    if (!user) return { ok: false, message: 'Aucun compte avec cette adresse.' };
    const hadSecret = await this.prisma.$transaction(async (tx) => {
      const removed = await tx.totpSecret.deleteMany({ where: { userId: user.id } });
      const codes = await tx.adminRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.session.updateMany({ where: { userId: user.id }, data: { adminVerifiedAt: null, adminLastSeenAt: null } });
      if (removed.count + codes.count === 0) return false;
      await this.audit.recordInTx(tx, {
        action: 'admin.2fa_reset',
        actorKind: 'cli',
        actorId: null,
        userId: user.id,
        metadata: { details: { recoveryCodesRemoved: codes.count } },
      });
      return true;
    });
    return hadSecret
      ? { ok: true, message: 'Double authentification réinitialisée : un nouvel enrôlement sera demandé à l’ouverture de /admin.' }
      : { ok: true, message: 'Aucune double authentification active sur ce compte (aucun changement).' };
  }
}

/** Contexte Nest minimal de la CLI : configuration, base, audit (aucun serveur HTTP, aucun job). */
@Module({})
export class AdminCliModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AdminCliModule,
      imports: [ApiConfigModule.forRoot(config), ApiPrismaModule],
      providers: [AuditService, AdminCliService],
    };
  }
}

/** Point d'entrée (appelé par `apps/api/src/cli.ts`). Renvoie le code de sortie du processus. */
export async function runAdminCli(
  argv: readonly string[],
  out: { log(message: string): void; error(message: string): void } = console,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const args = parseAdminCliArgs(argv);
  if ('error' in args) {
    out.error(`${args.error}\n${ADMIN_CLI_USAGE}`);
    return 2;
  }
  let config: AppConfig;
  try {
    config = loadConfig({ ...env, JOBS_ENABLED: '0' });
  } catch (error) {
    out.error(error instanceof Error ? error.message : 'Configuration invalide.');
    return 1;
  }
  const app = await NestFactory.createApplicationContext(AdminCliModule.forRoot(config), { logger: ['error'] });
  try {
    const outcome = await app.get(AdminCliService).run(args);
    (outcome.ok ? out.log : out.error).call(out, outcome.message);
    return outcome.ok ? 0 : 1;
  } finally {
    await app.close();
  }
}
