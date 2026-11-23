import { workspaceRoot } from '@nx/devkit';
import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client as PgClient } from 'pg';
import { APP_ORIGIN, createVerifiedAccount, loginViaApi } from './auth';
import { DATABASE_URL, api } from './watch';

/**
 * Espace admin (phase 6 bis, docs/ARCHITECTURE.md §14) contre l'API réelle : rôle par la CLI `make-admin`
 * (`dist/apps/api/cli.js`, construit par `nx run api:build` du webServer), enrôlement 2FA par l'API, code TOTP
 * RFC 6238 calculé ici (node:crypto), inactivité simulée par `POST internal/admin/age-session` (JOBS_TEST_TRIGGER=1).
 * GA4 et Search Console simulés : `ANALYTICS_PROVIDER=fake` (playwright.config.mts).
 */
const CLI = join(workspaceRoot, 'dist', 'apps', 'api', 'cli.js');
const run = promisify(execFile);

/**
 * Libellés copiés des contrats (web-e2e n'a pas de tag Nx et n'importe pas @raijin/shared-contracts) :
 * `ADMIN_USER_ACTION_LABELS`, `ADMIN_AUDIT_ACTION_LABELS`, `ADMIN_ERROR_MESSAGES`, `NOT_CONNECTED_LABEL`.
 */
export const ADMIN_LABELS = {
  grantProMonth: 'Offrir un mois de Pro',
  suspend: 'Suspendre le compte',
  auditProMonth: 'Mois de Pro offert',
  auditSuspended: 'Compte suspendu',
  invalidCode: 'Ce code n’est pas valide. Vérifie l’heure de ton téléphone et réessaie.',
  suspended: 'Ce compte est suspendu. Contacte-nous si tu penses qu’il s’agit d’une erreur.',
  notConnected: 'Non connecté',
} as const;

/** Les 9 écrans (miroir de `ADMIN_SCREENS`, libs/web/feature-admin/src/lib/shell/admin-screens.ts). */
export const ADMIN_SCREENS = [
  { slug: 'vue-ensemble', path: '/admin', label: 'Vue d’ensemble', title: 'Vue d’ensemble' },
  { slug: 'trafic', path: '/admin/trafic', label: 'Trafic', title: 'Trafic' },
  { slug: 'seo', path: '/admin/seo', label: 'SEO', title: 'SEO' },
  { slug: 'acquisition', path: '/admin/acquisition', label: 'Acquisition', title: 'Acquisition' },
  { slug: 'revenus', path: '/admin/revenus', label: 'Revenus', title: 'Revenus' },
  { slug: 'essais', path: '/admin/essais', label: 'Essais', title: 'Essais Pro' },
  { slug: 'utilisateurs', path: '/admin/utilisateurs', label: 'Utilisateurs', title: 'Utilisateurs' },
  { slug: 'produit', path: '/admin/produit', label: 'Produit', title: 'Produit' },
  { slug: 'sante', path: '/admin/sante', label: 'Santé', title: 'Santé' },
] as const;

export async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const pg = new PgClient({ connectionString: DATABASE_URL });
  await pg.connect();
  try {
    return (await pg.query(query, params)).rows as T[];
  } finally {
    await pg.end();
  }
}

/** Code TOTP (RFC 6238 : HMAC-SHA1, 6 chiffres, pas de 30 s) d'un secret base32 pour le pas `step`. */
export function totpAt(secret: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const currentStep = () => Math.floor(Date.now() / 30_000);

/**
 * Codes TOTP successifs d'un même secret. L'API refuse un pas déjà utilisé ou antérieur (anti-rejeu, fenêtre ±1) :
 * chaque appel renvoie le code du pas courant, ou du suivant (accepté) s'il a déjà servi, et attend au besoin.
 */
export class TotpClock {
  private lastStep = 0;
  constructor(readonly secret: string) {}

  async next(): Promise<string> {
    let step = Math.max(currentStep(), this.lastStep + 1);
    while (step > currentStep() + 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      step = Math.max(currentStep(), this.lastStep + 1);
    }
    this.lastStep = step;
    return totpAt(this.secret, step);
  }
}

/** CLI d'administration (`make-admin`, `admin-reset-2fa`) sur la base locale de l'API de test. */
export async function adminCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { cwd: workspaceRoot, env: { ...process.env, NODE_ENV: 'development' }, timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** Attribue le rôle ADMIN par la CLI (comme en production : `pnpm nx run api:make-admin --email=…`). */
export async function makeAdmin(email: string): Promise<void> {
  const result = await adminCli('make-admin', `--email=${email}`);
  expect(result.code, `CLI make-admin : ${result.stdout} ${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('Rôle admin attribué');
}

/** Compte vérifié (Gratuit) promu admin par la CLI, 2FA non activée. */
export async function newAdminAccount(prefix = 'admin'): Promise<{ email: string; password: string }> {
  const ctx = await request.newContext({ baseURL: APP_ORIGIN, extraHTTPHeaders: { 'X-Forwarded-For': randomIp() } });
  try {
    const account = await createVerifiedAccount(ctx, prefix);
    await makeAdmin(account.email);
    return account;
  } finally {
    await ctx.dispose();
  }
}

function randomIp(): string {
  return `10.251.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
}

/**
 * Enrôlement 2FA par l'API (contexte connecté) : secret base32, codes de secours, horloge TOTP. La confirmation exige
 * le code **et le mot de passe actuel** (`adminEnrollmentConfirmRequestSchema`, audit phase 6 bis m4).
 */
export async function enrollViaApi(ctx: APIRequestContext, currentPassword: string): Promise<{ clock: TotpClock; recoveryCodes: string[] }> {
  const start = await api(ctx, 'POST', '/admin/security/enrollment');
  expect(start.status, `POST admin/security/enrollment : ${JSON.stringify(start.body)}`).toBe(201);
  const clock = new TotpClock(String(start.body['secret']));
  const confirm = await api(ctx, 'POST', '/admin/security/enrollment/confirm', { code: await clock.next(), currentPassword });
  expect(confirm.status, `POST admin/security/enrollment/confirm : ${JSON.stringify(confirm.body)}`).toBe(200);
  return { clock, recoveryCodes: (confirm.body['recoveryCodes'] as { codes: string[] }).codes };
}

type AdminKind = 'enrolled' | 'pending';
const admins = new Map<AdminKind, Promise<{ email: string; password: string; userId: string }>>();

/**
 * Admin partagé par les tests d'un worker (suites responsive, axe, captures) :
 * - `enrolled` : 2FA activée par l'API (une seule fois) ; chaque test ouvre ensuite sa propre session ;
 * - `pending` : rôle ADMIN sans 2FA (écran d'activation ; l'enrôlement commencé n'est jamais confirmé).
 */
export function sharedAdmin(kind: AdminKind): Promise<{ email: string; password: string; userId: string }> {
  let admin = admins.get(kind);
  if (!admin) {
    admin = (async () => {
      const account = await newAdminAccount(`ecran-admin-${kind}`);
      const [row] = await sql<{ id: string }>(`SELECT "id" FROM "User" WHERE "email" = $1`, [account.email]);
      if (!row) throw new Error(`Compte admin introuvable : ${account.email}`);
      if (kind === 'enrolled') {
        const ctx = await request.newContext({ baseURL: APP_ORIGIN });
        try {
          await loginViaApi(ctx, account.email, account.password);
          await enrollViaApi(ctx, account.password);
        } finally {
          await ctx.dispose();
        }
      }
      return { ...account, userId: row.id };
    })();
    admins.set(kind, admin);
  }
  return admin;
}

/**
 * Session admin vérifiée pour les sessions ouvertes du compte, posée en base. Raccourci des suites d'écrans
 * (responsive, axe, captures) : un même secret ne sert qu'une fois par pas de 30 s (anti-rejeu), une saisie de
 * code par test serait impossible. Le vrai parcours (code saisi dans l'interface) est couvert par admin.flow.spec.ts.
 */
export async function markAdminSessionsVerified(userId: string): Promise<void> {
  await sql(
    `UPDATE "Session" SET "adminVerifiedAt" = now(), "adminLastSeenAt" = now() WHERE "userId" = $1::uuid AND "revokedAt" IS NULL`,
    [userId],
  );
}

/** Connexion du navigateur avec l'admin enrôlé partagé, session admin vérifiée. */
export async function loginVerifiedAdmin(page: Page): Promise<{ email: string; userId: string }> {
  const admin = await sharedAdmin('enrolled');
  await loginViaApi(page.context().request, admin.email, admin.password);
  await markAdminSessionsVerified(admin.userId);
  return admin;
}

/** Recule la session admin courante de `minutes` (route de test, JOBS_TEST_TRIGGER=1). */
export async function ageAdminSession(ctx: APIRequestContext, minutes: number): Promise<void> {
  const res = await api(ctx, 'POST', '/internal/admin/age-session', { minutes });
  expect(res.status, `internal/admin/age-session : ${JSON.stringify(res.body)}`).toBe(204);
}

/**
 * Écran d'activation : code de l'application **et** mot de passe actuel (contrat `adminEnrollmentConfirmRequestSchema`,
 * audit phase 6 bis), puis « Confirmer le code » (la saisie des 6 chiffres n'envoie plus le formulaire sur cet écran).
 * Champ ciblé par son libellé exact : le bouton « Afficher le mot de passe » contient aussi « mot de passe ».
 */
export async function submitEnrollment(page: Page, password: string, code: string): Promise<void> {
  const screen = page.locator('rj-admin-enrollment-page');
  await screen.getByLabel('Mot de passe actuel', { exact: true }).fill(password);
  await typeTotp(page, code);
  await screen.getByRole('button', { name: 'Confirmer le code' }).click();
}

/** Saisit un code dans le champ à 6 chiffres (sur l'écran de saisie du code, 6 chiffres envoient le formulaire). */
export async function typeTotp(page: Page, code: string): Promise<void> {
  const field = page.getByLabel('Code à 6 chiffres');
  await field.fill('');
  await field.pressSequentially(code);
}

/** Navigation des écrans : barre latérale dès 1024 px, rangée de pastilles en dessous. */
export function adminNav(page: Page) {
  return page.getByRole('navigation', { name: 'Écrans de l’admin' });
}
export const adminSidebar = (page: Page) => page.locator('rj-admin-shell > aside[aria-label="Espace admin"]');
export const adminTopBar = (page: Page) => page.locator('rj-admin-shell > div > header');
