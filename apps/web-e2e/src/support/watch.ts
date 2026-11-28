import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { Client as PgClient } from 'pg';
import { APP_ORIGIN, MAILPIT_URL } from './auth';

/**
 * Suivis, alertes et push contre l'API réelle (phase 4, docs/ARCHITECTURE.md §11) : l'API de test tourne
 * avec `JOBS_TEST_TRIGGER=1` (routes `internal/*`), `PUSH_PROVIDER=fake`, `ALERT_EMAIL_BATCH_DELAY_S=1` et
 * `ALERT_COOLDOWN_MINUTES=0` (playwright.config.mts). Les scénarios de fixtures en séquence sont avancés
 * par `POST internal/fixtures/:scenario` et les passes déclenchées par `POST internal/jobs/:name/run`.
 */
export const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';

/** Mints des scénarios de suivi (libs/api/solana/src/fixtures, fichiers `*.step<N>*.json`). */
export const WATCH_MINTS = {
  /** `watch-mint-reactivated` : autorités révoquées → mint actif (étape 1) → freeze actif (étape 2). */
  reactivated: '6kA3B4uMv3vuePwmUcH5ca3xWtV3KnfHzBfzTtWziG83',
  /** `watch-lp-removed` : référence → swap (étape 1) → retrait de liquidité ÷ 4 (étape 2). */
  lp: '3G8wFjRxfaPpi9t3CXrZY1JAd4CZFfZoPuZU1ggYif6i',
  /** `watch-holder-sold` : H1 cède 40 % de sa position (étape 1). Exige une clé Helius. */
  holder: '7kyyXC5ZbjLDGucQA2ucEHb6wrq8fiWxDRCcf2HWzQu4',
} as const;

async function csrfOf(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${APP_ORIGIN}/api/v1/auth/csrf`);
  expect(res.status(), 'GET /auth/csrf').toBe(200);
  return ((await res.json()) as { csrfToken: string }).csrfToken;
}

/**
 * Appel d'API avec la session du contexte (cookies), Origin et jeton CSRF. L'API de test émet des JWT
 * de 20 s (`JWT_ACCESS_TTL`) : un 401 déclenche un `POST auth/refresh` puis une seule relance, comme le front.
 */
export async function api(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const send = async () => {
    const headers: Record<string, string> = { Origin: APP_ORIGIN };
    if (method !== 'GET') headers['X-CSRF-Token'] = await csrfOf(request);
    return request.fetch(`${APP_ORIGIN}/api/v1${path}`, { method, data, headers });
  };
  let res = await send();
  if (res.status() === 401 && !path.startsWith('/auth/')) {
    await request.post(`${APP_ORIGIN}/api/v1/auth/refresh`, { headers: { Origin: APP_ORIGIN, 'X-CSRF-Token': await csrfOf(request) } });
    res = await send();
  }
  const text = await res.text();
  return { status: res.status(), body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Exécute un job tout de suite (passes sur les mints donnés). */
export async function runJob(request: APIRequestContext, name: string, mints?: string[]): Promise<Record<string, number>[]> {
  const res = await api(request, 'POST', `/internal/jobs/${name}/run`, mints ? { mints } : {});
  expect(res.status, `internal/jobs/${name}/run : ${JSON.stringify(res.body)}`).toBe(200);
  return res.body['results'] as Record<string, number>[];
}

export async function fixtureStep(request: APIRequestContext, scenario: string, step: number): Promise<void> {
  const res = await api(request, 'POST', `/internal/fixtures/${scenario}`, { step });
  expect(res.status, `internal/fixtures/${scenario} → ${step} : ${JSON.stringify(res.body)}`).toBe(200);
}

export interface OutboxItem {
  payload: { notification: { title: string; body: string; tag?: string; data: { alertId: string; onActionClick: { default: { url: string } } } } };
}

export async function pushOutbox(request: APIRequestContext): Promise<OutboxItem[]> {
  const res = await api(request, 'GET', '/internal/push/outbox');
  expect(res.status, 'internal/push/outbox').toBe(200);
  return res.body['items'] as OutboxItem[];
}

/** Analyse (pour la règle « analyse ≤ 24 h ») puis suivi par l'API ; renvoie le statut et le corps. */
export async function followViaApi(request: APIRequestContext, mint: string) {
  const analysis = await api(request, 'POST', '/analyses', { input: mint });
  expect(analysis.status, `analyse ${mint} : ${JSON.stringify(analysis.body)}`).toBe(200);
  return api(request, 'POST', '/watches', { mint });
}

export async function withPg<T>(run: (pg: PgClient) => Promise<T>): Promise<T> {
  const pg = new PgClient({ connectionString: DATABASE_URL });
  await pg.connect();
  try {
    return await run(pg);
  } finally {
    await pg.end();
  }
}

/**
 * Essai Pro de 7 jours posé en base sur un compte Gratuit (adresse jetable, `createVerifiedAccount` par défaut),
 * comme api-e2e : état d'essai indépendant de l'anti-abus. L'essai démarré par la vérification est testé dans
 * trial.flow.spec.ts.
 */
export function startTrial(email: string): Promise<void> {
  return withPg(async (pg) => {
    await pg.query(`UPDATE "User" SET "trialStatus" = 'ACTIVE', "trialStartedAt" = now(), "trialEndsAt" = now() + interval '7 days' WHERE "email" = $1`, [email]);
  });
}

/**
 * Analyse récente posée en base pour un mint sans fixtures d'analyse (scénarios LP et holder) :
 * copie de la dernière analyse d'un autre mint, adresse remplacée. Données de test seulement.
 */
export function seedAnalysis(mint: string, fromMint: string, symbol: string): Promise<void> {
  return withPg(async (pg) => {
    const res = await pg.query(
      `INSERT INTO "TokenAnalysis" ("id", "mint", "verdict", "score", "checks", "sources", "engineVersion", "facts", "token", "degraded", "explanation", "durationMs", "createdAt")
       SELECT gen_random_uuid(), $1, "verdict", "score", "checks", "sources", "engineVersion", "facts",
              jsonb_set(jsonb_set(jsonb_set("token"::jsonb, '{mint}', to_jsonb($1::text)), '{name}', to_jsonb($3::text)), '{symbol}', to_jsonb($3::text)),
              "degraded", "explanation", "durationMs", now()
       FROM "TokenAnalysis" WHERE "mint" = $2 AND "token" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1`,
      [mint, fromMint, symbol],
    );
    expect(res.rowCount, `analyse de référence de ${fromMint} en base`).toBe(1);
  });
}

/** Retire les suivis restants d'un mint (tests précédents interrompus) : l'état du mint repart d'une référence. */
export function purgeMintWatches(mint: string): Promise<void> {
  return withPg(async (pg) => {
    await pg.query(`DELETE FROM "Watch" WHERE "mint" = $1 AND "userId" IN (SELECT "id" FROM "User" WHERE "email" LIKE 'e2e-%@exemple.fr' OR "email" LIKE 'e2e-%@mailinator.com')`, [mint]);
    await pg.query(`DELETE FROM "MintWatchState" WHERE "mint" = $1 AND NOT EXISTS (SELECT 1 FROM "Watch" WHERE "Watch"."mint" = $1)`, [mint]);
  });
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Created: string;
}

/** E-mails Mailpit reçus par `to` dont l'objet contient `subject`. */
export async function mailsFor(to: string, subject: string | RegExp): Promise<MailpitSummary[]> {
  const query = encodeURIComponent(`to:"${to}"`);
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}&limit=50`);
  if (!res.ok) return [];
  const { messages } = (await res.json()) as { messages: MailpitSummary[] };
  return messages.filter((m) => m.To.some((t) => t.Address.toLowerCase() === to.toLowerCase()) && (typeof subject === 'string' ? m.Subject.includes(subject) : subject.test(m.Subject)));
}

/** Attend un e-mail et renvoie son identifiant Mailpit, son objet et son HTML. */
export async function waitForMailHtml(to: string, subject: string | RegExp, timeoutMs = 20_000): Promise<{ id: string; subject: string; html: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [found] = await mailsFor(to, subject);
    if (found) {
      const message = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`)).json()) as { HTML: string };
      return { id: found.ID, subject: found.Subject, html: message.HTML };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Aucun e-mail « ${String(subject)} » reçu par ${to} (Mailpit ${MAILPIT_URL})`);
}

/** Ouvre le rendu HTML d'un e-mail Mailpit dans la page (images chargées depuis APP_URL). */
export async function openMailHtml(page: Page, html: string): Promise<void> {
  await page.setContent(html, { waitUntil: 'load' });
}

const HOUR = 3_600_000;

/**
 * Historique d'alertes posé en base pour les écrans (responsive, axe, captures) : une alerte de chaque type
 * sur des mints suivis, dont une déjà lue. `eventId` nul et livraison marquée faite : aucun e-mail ni push.
 */
export function seedAlerts(email: string, mints: { danger: string; warn: string }): Promise<void> {
  const now = Date.now();
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
  const rows: { mint: string; type: string; severity: 'warn' | 'danger'; payload: unknown; hoursAgo: number; read: boolean }[] = [
    { mint: mints.danger, type: 'lp_removed', severity: 'danger', hoursAgo: 0.2, read: false, payload: { poolAddress: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9', dex: 'raydium', dropPct: 75, liquidityUsdBefore: 1_250_000, liquidityUsdAfter: 312_500, referenceAt: iso(3) } },
    { mint: mints.danger, type: 'verdict_degraded', severity: 'danger', hoursAgo: 1, read: false, payload: { from: 'warn', to: 'danger', reasonCodes: [], analysisId: null } },
    { mint: mints.danger, type: 'mint_reactivated', severity: 'danger', hoursAgo: 5, read: false, payload: { revokedObservedAt: iso(5.1) } },
    { mint: mints.warn, type: 'holder_sold', severity: 'warn', hoursAgo: 26, read: false, payload: { owner: 'kWv2Xjint8N2AmTAEXfQdR5qXDmhtRXnTKkhuXbhsCL', beforePct: 10, afterPct: 6, soldPctOfPosition: 40 } },
    { mint: mints.warn, type: 'freeze_reactivated', severity: 'danger', hoursAgo: 50, read: true, payload: { revokedObservedAt: iso(50.1) } },
  ];
  return withPg(async (pg) => {
    const user = await pg.query<{ id: string }>(`SELECT "id" FROM "User" WHERE "email" = $1`, [email]);
    const userId = user.rows[0]?.id;
    expect(userId, `compte ${email}`).toBeDefined();
    for (const row of rows) {
      await pg.query(
        `INSERT INTO "Alert" ("id", "userId", "eventId", "mint", "type", "severity", "payload", "token", "readAt", "emailedAt", "pushedAt", "emailSkipped", "createdAt")
         SELECT gen_random_uuid(), $1::uuid, NULL, $2, $3, $4::"AlertSeverity", $5::jsonb,
                (SELECT "token" FROM "TokenAnalysis" WHERE "mint" = $2 AND "token" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 1),
                CASE WHEN $6 THEN $7::timestamptz ELSE NULL END, $7::timestamptz, $7::timestamptz, true, $7::timestamptz`,
        [userId, row.mint, row.type, row.severity, JSON.stringify(row.payload), row.read, iso(row.hoursAgo)],
      );
    }
  });
}
