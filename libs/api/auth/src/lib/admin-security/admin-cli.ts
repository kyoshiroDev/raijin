import { Inject, Injectable, Logger, Module, Optional, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_CONFIG, ApiConfigModule, errorCode, loadConfig, redactCredentials, type AppConfig } from '@raijin/api-core';
import {
  ADMIN_NOTICE_BODY_MAX,
  ADMIN_NOTICE_TITLE_MAX,
  adminNoticeTemplate,
  ApiNotificationsModule,
  cleanNoticeText,
  Mailer,
  PushSender,
} from '@raijin/api-notifications';
import { ApiPrismaModule, PrismaService } from '@raijin/api-prisma';
import { emailSchema, type PushNotificationPayload } from '@raijin/shared-contracts';
import { AuditService } from '../audit/audit.service';
import { normalizeEmail } from '../services/email-normalizer';

/**
 * Outils d'administration en ligne de commande (docs/ARCHITECTURE.md §14.2, §14.3), **jamais depuis l'interface** :
 * - `pnpm nx run api:make-admin --email=… [--revoke]` : attribue (ou retire) le rôle ADMIN ;
 * - `pnpm nx run api:admin-reset-2fa --email=…` : efface la 2FA (téléphone et codes de secours perdus) ;
 * - `node dist/apps/api/cli.js notify-admins --title=… --stdin` : avis d'exploitation (watchdog, sauvegardes,
 *   `infra/lib/common.sh`) envoyé par e-mail et push à chaque compte ADMIN actif ; corps lu sur l'entrée standard
 *   (texte brut, 2 000 caractères au plus) ; code de sortie 1 si aucun envoi n'a réussi.
 * En production : `docker compose exec api node cli.js make-admin --email=…` (lancé par l'utilisateur, docs/DEPLOY.md).
 * Chaque changement est audité (`actorKind: cli`). Aucune sortie ne contient de secret.
 */

export type AdminCliCommand = 'make-admin' | 'admin-reset-2fa' | 'notify-admins';

export type AdminCliArgs =
  | { readonly command: 'make-admin' | 'admin-reset-2fa'; readonly email: string; readonly revoke: boolean }
  | { readonly command: 'notify-admins'; readonly title: string; readonly stdin: true };

/** Octets lus au plus sur l'entrée standard (le corps est ensuite borné à 2 000 caractères). */
export const NOTIFY_STDIN_MAX_BYTES = 16_384;

export type AdminCliOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

export const ADMIN_CLI_USAGE = [
  'Usage :',
  '  pnpm nx run api:make-admin --email=ton@email [--revoke]',
  '  pnpm nx run api:admin-reset-2fa --email=ton@email',
  '  node dist/apps/api/cli.js notify-admins --title="Objet" --stdin < corps.txt',
].join('\n');

function parseNotifyArgs(rest: readonly string[]): AdminCliArgs | { error: string } {
  let title: string | undefined;
  let stdin = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? '';
    if (arg === '--stdin') stdin = true;
    else if (arg.startsWith('--title=')) title = arg.slice('--title='.length);
    else if (arg === '--title') title = rest[++index];
    else return { error: `Option inconnue : ${arg.slice(0, 40)}` };
  }
  if (!stdin) return { error: '--stdin est obligatoire (corps lu sur l’entrée standard).' };
  const clean = cleanNoticeText(title ?? '', ADMIN_NOTICE_TITLE_MAX);
  if (!clean) return { error: 'Titre manquant (--title="…").' };
  return { command: 'notify-admins', title: clean, stdin: true };
}

/** Lit `<commande> --email=… [--revoke]` (aussi `--email …`). `null` si invalide. */
export function parseAdminCliArgs(argv: readonly string[]): AdminCliArgs | { error: string } {
  const [command, ...rest] = argv;
  if (command === 'notify-admins') return parseNotifyArgs(rest);
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

/** Notification push d'un avis d'exploitation (enveloppe du service worker Angular, clic → santé technique). */
export function adminNoticePushPayload(title: string, body: string, now: Date): PushNotificationPayload {
  const payload = {
    notification: {
      title: `Raijin admin : ${title}`.slice(0, 80),
      body: (body.split('\n')[0] ?? '').slice(0, 240) || 'Ouvre la santé technique.',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: 'admin-notice',
      renotify: true,
      lang: 'fr',
      timestamp: now.getTime(),
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/admin/sante' } } },
    },
  };
  return payload as unknown as PushNotificationPayload;
}

@Injectable()
export class AdminCliService {
  private readonly logger = new Logger('AdminCli');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly mailer?: Mailer,
    @Optional() private readonly push?: PushSender,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
  ) {}

  run(args: AdminCliArgs, now: Date = new Date(), body = ''): Promise<AdminCliOutcome> {
    if (args.command === 'notify-admins') return this.notifyAdmins(args.title, body, now);
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

  /**
   * Avis d'exploitation à chaque compte ADMIN actif (rôle ADMIN, non suspendu, e-mail vérifié) : e-mail (thème clair,
   * texte échappé) et push sur ses appareils. Réussite = au moins un envoi. Journaux : compteurs et codes d'erreur
   * seulement (jamais d'adresse, d'endpoint ni le contenu). Audité (`admin.cli_notified`, `actorKind: cli`).
   */
  async notifyAdmins(title: string, rawBody: string, now: Date = new Date()): Promise<AdminCliOutcome> {
    if (!this.mailer || !this.push || !this.config) return { ok: false, message: 'Notifications indisponibles.' };
    const body = cleanNoticeText(rawBody, ADMIN_NOTICE_BODY_MAX);
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', suspendedAt: null, emailVerifiedAt: { not: null } },
      select: { email: true, pushSubscriptions: { select: { endpoint: true, p256dh: true, auth: true } } },
    });
    if (admins.length === 0) return { ok: false, message: 'Aucun compte admin actif : rien envoyé.' };
    const mail = adminNoticeTemplate({ logoUrl: this.config.mail.logoUrl, appUrl: this.config.appUrl }, title, body);
    const payload = adminNoticePushPayload(title, body, now);
    let emails = 0;
    let pushes = 0;
    let failures = 0;
    for (const admin of admins) {
      try {
        await this.mailer.send({ to: admin.email, ...mail });
        emails += 1;
      } catch (error) {
        failures += 1;
        this.logger.warn(`E-mail d'avis admin non envoyé (${errorCode(error)})`);
      }
      for (const target of admin.pushSubscriptions) {
        const result = await this.push.send(target, payload, { ttlSeconds: 3_600, urgency: 'high' }).catch(() => ({ status: 'failed' as const }));
        if (result.status === 'sent') pushes += 1;
        else failures += 1;
      }
    }
    await this.audit.recordStrict({
      action: 'admin.cli_notified',
      actorKind: 'cli',
      actorId: null,
      userId: null,
      metadata: { details: { title: title.slice(0, 200), admins: admins.length, emails, pushes, failures } },
    });
    const summary = `${emails} e-mail(s), ${pushes} push, ${failures} échec(s).`;
    return emails + pushes > 0 ? { ok: true, message: `Avis envoyé : ${summary}` } : { ok: false, message: `Aucun envoi réussi : ${summary}` };
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
      imports: [ApiConfigModule.forRoot(config), ApiPrismaModule, ApiNotificationsModule],
      providers: [AuditService, AdminCliService],
    };
  }
}

/** Point d'entrée (appelé par `apps/api/src/cli.ts`). Renvoie le code de sortie du processus. */
/** Lit l'entrée standard (texte, borné à `NOTIFY_STDIN_MAX_BYTES`). */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin, maxBytes = NOTIFY_STDIN_MAX_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (size < maxBytes) chunks.push(buffer.subarray(0, maxBytes - size));
    size += buffer.length;
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function runAdminCli(
  argv: readonly string[],
  out: { log(message: string): void; error(message: string): void } = console,
  env: NodeJS.ProcessEnv = process.env,
  stdin: () => Promise<string> = () => readStdin(),
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
    out.error(error instanceof Error ? redactCredentials(error.message) : 'Configuration invalide.');
    return 1;
  }
  const app = await NestFactory.createApplicationContext(AdminCliModule.forRoot(config), { logger: ['error'] });
  try {
    const body = args.command === 'notify-admins' ? await stdin() : '';
    const outcome = await app.get(AdminCliService).run(args, new Date(), body);
    (outcome.ok ? out.log : out.error).call(out, outcome.message);
    return outcome.ok ? 0 : 1;
  } finally {
    await app.close();
  }
}
