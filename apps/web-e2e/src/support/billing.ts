import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { APP_ORIGIN, createVerifiedAccount, freshIp } from './auth';
import { MINTS } from './analysis';
import { api, followViaApi, withPg } from './watch';

/**
 * Abonnement et essai Pro (phase 6, docs/ARCHITECTURE.md §13) contre l'API réelle en simulation
 * (`BILLING_PROVIDER=fake`, playwright.config.mts) : faux Checkout et faux portail signés localement et traités
 * comme de vrais webhooks ; horloge de l'essai avancée par `POST internal/trial/tick {now, userId}`
 * (`JOBS_TEST_TRIGGER=1`, limité au compte du test).
 */
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface Account {
  email: string;
  password: string;
}

export interface PlansBody {
  mode: 'stripe' | 'simulation' | 'unavailable';
  free: { entitlements: Record<string, unknown> };
  pro: { monthly: { amountCents: number; currency: string }; yearly: { amountCents: number; currency: string } };
  trial: { days: number };
}

/** Offres publiques renvoyées par l'API (`GET billing/plans`). */
export async function plansFromApi(owner: APIRequestContext): Promise<PlansBody> {
  const res = await owner.get(`${APP_ORIGIN}/api/v1/billing/plans`);
  expect(res.status(), 'GET billing/plans').toBe(200);
  return (await res.json()) as PlansBody;
}

/** Même formatage que l'écran (fr-FR, devise de l'API, centimes masqués quand ils sont nuls). */
export function formatPrice(amountCents: number, currency: string): string {
  const digits = amountCents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(amountCents / 100);
}

/** Économie de l'annuel par rapport à 12 mensualités (même calcul que `yearlySavingsPercent` des contrats). */
export function savingsPercent(monthlyCents: number, yearlyCents: number): number {
  const twelve = monthlyCents * 12;
  if (twelve <= 0 || yearlyCents >= twelve) return 0;
  return Math.round((1 - yearlyCents / twelve) * 100);
}

/** Texte comparable : espaces insécables (Intl) ramenés à des espaces simples. */
export const plain = (text: string | null | undefined) => (text ?? '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();

export interface UserRow {
  id: string;
  plan: string;
  trialStatus: string;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
}

export function userRow(email: string): Promise<UserRow> {
  return withPg(async (pg) => {
    const res = await pg.query<UserRow>(// Colonnes `timestamp` sans fuseau (UTC, Prisma) : relues en `timestamptz` UTC, sinon le pilote pg les prend pour
      // des heures locales (décalage d'une heure à Paris).
      `SELECT "id", "plan"::text AS "plan", "trialStatus"::text AS "trialStatus",
              "trialStartedAt" AT TIME ZONE 'UTC' AS "trialStartedAt", "trialEndsAt" AT TIME ZONE 'UTC' AS "trialEndsAt"
         FROM "User" WHERE "email" = $1`, [email]);
    const row = res.rows[0];
    expect(row, `compte ${email}`).toBeDefined();
    return row as UserRow;
  });
}

/** Motif interne du refus d'essai (`ProductEvent trial_refused`), jamais exposé à l'utilisateur. */
export function refusalReason(email: string): Promise<string | undefined> {
  return withPg(async (pg) => {
    const res = await pg.query<{ reason: string }>(
      `SELECT e."properties"->>'reason' AS reason FROM "ProductEvent" e JOIN "User" u ON u."id" = e."userId" WHERE u."email" = $1 AND e."type" = 'trial_refused'`,
      [email],
    );
    return res.rows[0]?.reason;
  });
}

function parisHour(date: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Paris' }).format(date));
}

/** Premier instant ≥ `from` (par pas de 30 min) entre 10 h et 21 h à Paris : fenêtre d'envoi des e-mails J+1 / J-2. */
export function nextSendingSlot(from: Date): Date {
  let at = new Date(from.getTime() + 60_000);
  while (parisHour(at) < 10 || parisHour(at) >= 21) at = new Date(at.getTime() + 30 * 60_000);
  return at;
}

/** Job de l'essai exécuté à l'instant `now` pour ce seul compte. */
export async function trialTick(owner: APIRequestContext, now: Date, userId: string): Promise<Record<string, number>> {
  const res = await api(owner, 'POST', '/internal/trial/tick', { now: now.toISOString(), userId });
  expect(res.status, `internal/trial/tick : ${JSON.stringify(res.body)}`).toBe(200);
  return res.body as Record<string, number>;
}

/**
 * Fin d'essai complète : job à l'échéance (Gratuit, suivis au-delà de 3 en pause, e-mail J0), puis essai décalé
 * dans le passé en base (fin il y a 1 h) pour que l'horloge réelle du reste de l'API et du navigateur le voie
 * terminé. Les événements produit du compte (analyses faites pendant l'essai) sont décalés d'autant : le
 * récapitulatif les compte toujours dans la fenêtre de l'essai.
 */
export async function expireTrial(owner: APIRequestContext, email: string): Promise<Record<string, number>> {
  const row = await userRow(email);
  expect(row.trialEndsAt, 'essai démarré').not.toBeNull();
  const endsAt = row.trialEndsAt as Date;
  const result = await trialTick(owner, new Date(endsAt.getTime() + 5 * 60_000), row.id);
  const shiftSeconds = (endsAt.getTime() - (Date.now() - HOUR)) / 1000;
  await withPg(async (pg) => {
    await pg.query(
      `UPDATE "User" SET "trialStartedAt" = "trialStartedAt" - make_interval(secs => $2), "trialEndsAt" = "trialEndsAt" - make_interval(secs => $2) WHERE "id" = $1`,
      [row.id, shiftSeconds],
    );
    await pg.query(`UPDATE "ProductEvent" SET "createdAt" = "createdAt" - make_interval(secs => $2) WHERE "userId" = $1`, [row.id, shiftSeconds]);
  });
  return result;
}

/** Les 5 mints des fixtures analysables : 5 suivis pendant l'essai (Gratuit : 3). */
export const FIVE_MINTS = [MINTS.bonk, MINTS.usdc, MINTS.pyusd, MINTS.honeypot, MINTS.mintActive] as const;

export async function followFive(owner: APIRequestContext): Promise<void> {
  for (const mint of FIVE_MINTS) {
    const res = await followViaApi(owner, mint);
    expect(res.status, `suivi ${mint} : ${JSON.stringify(res.body)}`).toBe(201);
  }
}

/** Session du faux Checkout (`/abonnement/simulation?session=cs_fake_…`) créée par l'API. */
export async function checkoutSession(owner: APIRequestContext, interval: 'month' | 'year' = 'month'): Promise<string> {
  const res = await api(owner, 'POST', '/billing/checkout-sessions', { interval });
  expect(res.status, `billing/checkout-sessions : ${JSON.stringify(res.body)}`).toBe(200);
  const url = new URL(String(res.body['url']));
  expect(url.pathname).toBe('/abonnement/simulation');
  return url.searchParams.get('session') ?? '';
}

/** Abonnement Pro simulé par l'API (paiement accepté ou refusé), sans passer par l'interface. */
export async function subscribeViaApi(owner: APIRequestContext, outcome: 'paid' | 'payment_failed' = 'paid', interval: 'month' | 'year' = 'month'): Promise<void> {
  const sessionId = await checkoutSession(owner, interval);
  const res = await api(owner, 'POST', '/billing/simulation/checkout', { sessionId, outcome });
  expect(res.status, `billing/simulation/checkout : ${JSON.stringify(res.body)}`).toBe(200);
}

type BillingKind = 'essai' | 'pro' | 'retard' | 'fin-essai' | 'resilie';
const seeded = new Map<BillingKind, Promise<Account>>();

/**
 * Comptes préparés par l'API réelle (un par worker et par état), pour les écrans responsive, axe et captures :
 * essai réellement démarré par la vérification, Pro mensuel, Pro en retard de paiement, Pro résilié en fin de
 * période, essai terminé avec 5 suivis (écran de fin et choix des suivis, jamais validés ici).
 */
export function billingAccount(kind: BillingKind): Promise<Account> {
  let account = seeded.get(kind);
  if (!account) {
    account = (async () => {
      const owner = await request.newContext({ baseURL: APP_ORIGIN, extraHTTPHeaders: { 'X-Forwarded-For': freshIp() } });
      try {
        const trial = kind === 'essai' || kind === 'fin-essai';
        const created = await createVerifiedAccount(owner, `ecran-${kind}`, trial ? 'trial' : 'free');
        if (trial) expect((await userRow(created.email)).trialStatus, 'essai démarré à la vérification').toBe('ACTIVE');
        if (kind === 'pro' || kind === 'resilie') await subscribeViaApi(owner, 'paid', kind === 'resilie' ? 'year' : 'month');
        if (kind === 'retard') await subscribeViaApi(owner, 'payment_failed', 'year');
        if (kind === 'resilie') {
          const res = await api(owner, 'POST', '/billing/simulation/portal', { action: 'cancel_at_period_end' });
          expect(res.status, `simulation/portal : ${JSON.stringify(res.body)}`).toBe(200);
        }
        if (kind === 'fin-essai') {
          await followFive(owner);
          expect(await expireTrial(owner, created.email)).toMatchObject({ expired: 1, pausedWatches: 2 });
        }
        return created;
      } finally {
        await owner.dispose();
      }
    })();
    seeded.set(kind, account);
  }
  return account;
}

/**
 * Remplace `mode` dans les vraies réponses de `billing/plans` et `billing/subscription` (le front lit le mode du
 * compte s'il est connecté) : paiement indisponible, comme une API sans clés Stripe.
 */
export async function forceBillingMode(page: Page, mode: PlansBody['mode']): Promise<void> {
  for (const path of ['plans', 'subscription']) {
    await page.route(`**/api/v1/billing/${path}`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, mode } });
    });
  }
}

/** Laisse passer une file asynchrone (e-mails BullMQ) avant de compter : rien ne doit arriver en plus. */
export const settle = (ms = 1_500) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Hôte du bandeau chargé (`@defer` déclenché pour un compte en essai ou à l'essai terminé sans abonnement). */
export async function bannerHostReady(page: Page): Promise<void> {
  await expect(page.locator('rj-trial-banner-host')).toBeAttached({ timeout: 15_000 });
}

/** Bandeau d'essai de la coque. */
export const trialBanner = (page: Page) => page.getByRole('region', { name: 'Essai Pro' });

/** Image de Rai dans une pose donnée. */
export const raiPose = (page: Page, pose: string) => page.locator(`rj-mascot img[src$="rai-${pose}.svg"]`);
