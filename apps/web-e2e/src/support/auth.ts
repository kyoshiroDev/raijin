import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

type RequestOwner = BrowserContext | APIRequestContext;
const requestOf = (owner: RequestOwner): APIRequestContext => ('request' in owner ? owner.request : owner);

/**
 * Outils des parcours d'auth contre l'API réelle (docs/ARCHITECTURE.md §8) :
 * infra `pnpm nx run api:dev-infra` (Postgres 5433, Redis 6380, Mailpit 8026), API 3100, web 4200 (proxy /api).
 */
export const MAILPIT_URL = process.env['MAILPIT_URL'] ?? 'http://localhost:8026';
export const APP_ORIGIN = process.env['BASE_URL'] ?? 'http://localhost:4200';

/** Mot de passe valide (12 à 128 caractères, règles NIST de PROMPT.md / contrats). */
export const PASSWORD = 'une phrase de passe solide 2026';
export const NEW_PASSWORD = 'encore une autre phrase longue';

/** Cookies d'auth en dev (`COOKIE_SECURE=false`), §8.4. */
export const AUTH_COOKIES = ['rj_at', 'rj_rt', 'rj_csrf'] as const;

/** Adresse unique d'un domaine ordinaire : éligible à l'essai Pro de 7 jours (phase 6) à la vérification. */
export function uniqueEmail(prefix: string): string {
  return `e2e-${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@exemple.fr`;
}

/**
 * Adresse unique d'un domaine jetable (liste de l'anti-abus, docs/ARCHITECTURE.md §13.6) : le compte reste en
 * Gratuit après vérification (pas d'essai Pro), comme `uniqueFreeEmail` d'api-e2e. Mailpit reçoit tout (SMTP local).
 */
export function uniqueFreeEmail(prefix: string): string {
  return uniqueEmail(prefix).replace(/@exemple\.fr$/, '@mailinator.com');
}

/** IP fictive (API de test en TRUST_PROXY=1) : empreinte d'essai neuve (IP + navigateur), quota anonyme neuf. */
export function freshIp(): string {
  const b = Array.from({ length: 3 }, () => Math.floor(Math.random() * 256));
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Created: string;
}

/**
 * Attend un e-mail Mailpit pour `to` dont l'objet contient `subject` et renvoie son texte.
 * `after` : ignore les e-mails plus anciens (plusieurs e-mails du même type pour une adresse).
 */
export async function waitForMail(to: string, subject: string, after = 0, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const query = encodeURIComponent(`to:"${to}"`);
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}&limit=50`);
    if (res.ok) {
      const { messages } = (await res.json()) as { messages: MailpitSummary[] };
      const found = messages.find(
        (m) =>
          m.To.some((t) => t.Address.toLowerCase() === to.toLowerCase()) &&
          m.Subject.includes(subject) &&
          Date.parse(m.Created) >= after,
      );
      if (found) {
        const message = await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`);
        return ((await message.json()) as { Text: string }).Text;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Aucun e-mail « ${subject} » reçu par ${to} (Mailpit ${MAILPIT_URL})`);
}

/** Chemin + requête (`/compte/…?token=…`) du lien de l'e-mail, à ouvrir sur le serveur de test. */
export function linkFrom(text: string, path: string): string {
  const match = new RegExp(`https?://[^\\s"<>]+(${path.replace(/[/-]/g, '\\$&')}\\?token=[A-Za-z0-9_-]+)`).exec(text);
  if (!match?.[1]) throw new Error(`Lien ${path} introuvable dans l'e-mail :\n${text.slice(0, 500)}`);
  return match[1];
}

/** Requête d'API faite par le contexte (cookies partagés avec le navigateur), avec Origin et CSRF. */
async function apiPost(request: APIRequestContext, path: string, csrf: string, data: unknown, extra: Record<string, string> = {}) {
  return request.post(`${APP_ORIGIN}/api/v1${path}`, {
    data,
    headers: { Origin: APP_ORIGIN, 'X-CSRF-Token': csrf, ...extra },
  });
}

async function anonymousCsrf(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${APP_ORIGIN}/api/v1/auth/csrf`);
  expect(res.status(), 'GET /auth/csrf').toBe(200);
  return ((await res.json()) as { csrfToken: string }).csrfToken;
}

/**
 * Crée un compte vérifié par l'API (sans passer par l'interface) : inscription, e-mail Mailpit,
 * vérification. Le contexte se retrouve connecté (cookies posés par la vérification).
 *
 * Phase 6 : la vérification d'une adresse ordinaire démarre un essai Pro de 7 jours (une fois par empreinte
 * IP + navigateur). `plan` rend le résultat déterministe :
 * - `free` (défaut) : adresse jetable → compte Gratuit, quel que soit l'ordre des tests ;
 * - `trial` : adresse ordinaire, vérification depuis une IP fictive neuve → essai Pro réellement démarré.
 */
export async function createVerifiedAccount(context: RequestOwner, prefix = 'compte', plan: 'free' | 'trial' = 'free') {
  const request = requestOf(context);
  const { email, link } = await registerViaApi(request, prefix, plan === 'free' ? uniqueFreeEmail(prefix) : uniqueEmail(prefix));
  const token = new URL(link, APP_ORIGIN).searchParams.get('token');
  const extra: Record<string, string> = plan === 'trial' ? { 'X-Forwarded-For': freshIp() } : {};
  const csrf = await anonymousCsrf(request);
  const verify = await apiPost(request, '/auth/verify-email', csrf, { token }, extra);
  expect(verify.status(), `POST /auth/verify-email : ${await verify.text()}`).toBe(200);
  return { email, password: PASSWORD };
}

/** Inscription par l'API, sans vérification : renvoie le lien de confirmation reçu dans Mailpit. */
export async function registerViaApi(context: RequestOwner, prefix = 'compte', email = uniqueEmail(prefix)) {
  const request = requestOf(context);
  const since = Date.now() - 1000;
  const csrf = await anonymousCsrf(request);
  const register = await apiPost(request, '/auth/register', csrf, { email, password: PASSWORD, acceptTerms: true });
  expect(register.status(), `POST /auth/register : ${await register.text()}`).toBe(202);
  const text = await waitForMail(email, 'Confirme ton adresse', since);
  return { email, password: PASSWORD, link: linkFrom(text, '/compte/verifier-email') };
}

/** Connexion par l'API dans le contexte du navigateur (cookies httpOnly posés). */
export async function loginViaApi(context: RequestOwner, email: string, password: string): Promise<void> {
  const request = requestOf(context);
  const csrf = await anonymousCsrf(request);
  const res = await apiPost(request, '/auth/login', csrf, { email, password });
  expect(res.status(), `POST /auth/login : ${await res.text()}`).toBe(200);
}

/** Aucun jeton dans le stockage web (§8.4) : clés et valeurs de localStorage et sessionStorage. */
export function webStorageDump(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i) ?? '';
        out.push(`${key}=${store.getItem(key) ?? ''}`);
      }
    }
    return out;
  });
}
