import { hashPassword } from '@raijin/server-security';
import { newPasswordSchema, totpCodeSchema } from '@raijin/shared-contracts';
import { renderUnicodeCompact } from 'uqr';
import { BenchAuthStore } from '../auth/auth.store';
import { BenchSecondFactor } from '../auth/second-factor';
import type { BenchConfig } from '../config/bench-config';

/** Entrées-sorties de la CLI (terminal réel ou faux pour les tests). */
export interface BenchCliIo {
  out(line: string): void;
  err(line: string): void;
  /** Lit une ligne ; `secret` : saisie masquée (mot de passe). */
  prompt(question: string, options?: { secret?: boolean }): Promise<string>;
}

export interface BenchCliDeps {
  readonly store: BenchAuthStore;
  readonly config: BenchConfig;
  readonly io: BenchCliIo;
  readonly now?: () => Date;
  /** Affiche le QR code du TOTP (désactivé dans les tests). */
  readonly showQr?: boolean;
}

export const BENCH_CLI_COMMANDS = ['create-owner', 'set-password', 'reset-2fa', 'enroll-totp', 'reset-totp', 'help'] as const;
const MAX_TRIES = 3;

export const BENCH_CLI_USAGE = [
  'Usage : node cli.js <commande>   (dans le conteneur raijin-bench-api, lancé par toi)',
  '  create-owner   crée le compte unique (BENCH_OWNER_EMAIL) : mot de passe, TOTP et 10 codes de secours',
  '  set-password   change le mot de passe (toutes les sessions sont fermées)',
  '  reset-2fa      nouveau secret TOTP et nouveaux codes de secours (sessions fermées) ; alias : enroll-totp, reset-totp',
  'Aucun secret en argument : le mot de passe est demandé au clavier (saisie masquée).',
];

async function askNewPassword(io: BenchCliIo, email: string): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const password = await io.prompt('Nouveau mot de passe (12 caractères minimum) : ', { secret: true });
    const parsed = newPasswordSchema.safeParse(password);
    if (!parsed.success) {
      io.err(parsed.error.issues[0]?.message ?? 'Mot de passe refusé.');
      continue;
    }
    if (password.trim().toLowerCase() === email) {
      io.err('Le mot de passe ne peut pas être l’adresse e-mail.');
      continue;
    }
    const confirmation = await io.prompt('Confirme le mot de passe : ', { secret: true });
    if (confirmation !== password) {
      io.err('Les deux saisies diffèrent.');
      continue;
    }
    return password;
  }
  return null;
}

/** Pose un nouveau TOTP (en attente), le fait confirmer par un code, puis affiche les codes de secours. */
async function enrollSecondFactor(deps: BenchCliDeps, ownerId: string): Promise<boolean> {
  const { io, store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const factor = new BenchSecondFactor(config.auth.totpKey);
  const enrollment = factor.enroll(ownerId, config.ownerEmail);
  await store.replaceSecondFactor(ownerId, enrollment.secretEncrypted, enrollment.recoveryHashes, now());
  io.out('');
  io.out('Ajoute ce compte dans ton application d’authentification (scanne le QR code ou saisis la clé) :');
  if (deps.showQr !== false) io.out(renderUnicodeCompact(enrollment.uri, { border: 1 }));
  io.out(`Clé : ${enrollment.secretBase32}`);
  io.out(`URI : ${enrollment.uri}`);
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const code = totpCodeSchema.safeParse(await io.prompt('Code à 6 chiffres affiché par l’application : '));
    const step = code.success ? factor.matchTotp(ownerId, enrollment.secretEncrypted, code.data, now(), null) : null;
    if (step === null) {
      io.err('Code incorrect.');
      continue;
    }
    await store.enableTotp(ownerId, step, now());
    io.out('');
    io.out('TOTP activé. Codes de secours (usage unique, à noter hors ligne ; ils ne seront plus affichés) :');
    for (const recovery of enrollment.recoveryCodes) io.out(`  ${recovery}`);
    return true;
  }
  io.err('TOTP non activé : connexion impossible tant que reset-2fa n’a pas abouti.');
  return false;
}

/**
 * CLI d'administration du compte unique du banc (docs/ARCHITECTURE.md §17.7) : la seule façon de poser ou
 * changer le mot de passe et le TOTP (aucune route HTTP d'inscription ni de réinitialisation). Code de sortie :
 * 0 succès, 1 refus ou échec, 64 usage.
 */
export async function runBenchCli(argv: readonly string[], deps: BenchCliDeps): Promise<number> {
  const { io, store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || !(BENCH_CLI_COMMANDS as readonly string[]).includes(command)) {
    for (const line of BENCH_CLI_USAGE) (command && command !== 'help' && command !== '--help' ? io.err : io.out)(line);
    return command && command !== 'help' && command !== '--help' ? 64 : 0;
  }
  if (argv.length > 1) {
    io.err('Aucun argument attendu après la commande (rien de secret en ligne de commande).');
    return 64;
  }

  const owner = await store.findOwner();
  if (command === 'create-owner') {
    if (owner?.passwordHash) {
      io.err('Le propriétaire existe déjà : utilise set-password ou reset-2fa.');
      return 1;
    }
    io.out(`Création du propriétaire du banc : ${config.ownerEmail}`);
    const password = await askNewPassword(io, config.ownerEmail);
    if (!password) return 1;
    const ownerId = await store.saveOwnerPassword(config.ownerEmail, await hashPassword(password), now());
    return (await enrollSecondFactor(deps, ownerId)) ? 0 : 1;
  }

  if (!owner?.passwordHash) {
    io.err('Aucun propriétaire : lance d’abord create-owner.');
    return 1;
  }
  if (command === 'set-password') {
    const password = await askNewPassword(io, config.ownerEmail);
    if (!password) return 1;
    await store.saveOwnerPassword(config.ownerEmail, await hashPassword(password), now());
    const revoked = await store.revokeAllSessions(owner.id, 'password_change', now());
    io.out(`Mot de passe changé ; ${revoked} session(s) fermée(s).`);
    return 0;
  }

  // reset-2fa, enroll-totp, reset-totp
  const revoked = await store.revokeAllSessions(owner.id, 'totp_reset', now());
  io.out(`${revoked} session(s) fermée(s). Nouveau second facteur pour ${config.ownerEmail}.`);
  return (await enrollSecondFactor(deps, owner.id)) ? 0 : 1;
}
