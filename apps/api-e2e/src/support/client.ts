import axios, { type AxiosResponse } from 'axios';

export const ORIGIN = process.env['E2E_ORIGIN'] ?? 'http://localhost:4200';
export const MAILPIT_URL = process.env['MAILPIT_URL'] ?? 'http://localhost:8026';

/** Client HTTP avec bocal à cookies et jeton CSRF en mémoire (comme le front). */
export class ApiClient {
  readonly cookies = new Map<string, string>();
  csrfToken = '';
  /** En-têtes ajoutés à chaque requête (ex. X-Forwarded-For : IP simulée, l'API de test fait confiance à 1 proxy). */
  readonly headers: Record<string, string> = {};

  private store(res: AxiosResponse): void {
    const header = res.headers['set-cookie'] ?? [];
    for (const raw of header) {
      const [pair = ''] = raw.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (/Expires=Thu, 01 Jan 1970/i.test(raw) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const token = (res.data as { csrfToken?: unknown } | undefined)?.csrfToken;
    if (typeof token === 'string') this.csrfToken = token;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Requête brute (corps binaire, en-têtes de réponse). */
  async raw(path: string): Promise<AxiosResponse<Buffer>> {
    return axios.get<Buffer>(`/api/v1${path}`, {
      responseType: 'arraybuffer',
      validateStatus: () => true,
      headers: { ...this.headers, Origin: ORIGIN },
    });
  }

  async request<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    data?: unknown,
  ): Promise<AxiosResponse<T>> {
    const res = await axios.request<T>({
      method,
      url: `/api/v1${path}`,
      data,
      validateStatus: () => true,
      headers: {
        ...this.headers,
        Origin: ORIGIN,
        ...(this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {}),
        ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
      },
    });
    this.store(res);
    return res;
  }

  get<T = Record<string, unknown>>(path: string) {
    return this.request<T>('GET', path);
  }

  post<T = Record<string, unknown>>(path: string, data: unknown = {}) {
    return this.request<T>('POST', path, data);
  }

  patch<T = Record<string, unknown>>(path: string, data: unknown = {}) {
    return this.request<T>('PATCH', path, data);
  }

  delete<T = Record<string, unknown>>(path: string, data: unknown = {}) {
    return this.request<T>('DELETE', path, data);
  }

  async init(): Promise<this> {
    await this.get('/auth/csrf');
    return this;
  }

  clone(): ApiClient {
    const copy = new ApiClient();
    Object.assign(copy.headers, this.headers);
    this.cookies.forEach((value, name) => copy.cookies.set(name, value));
    copy.csrfToken = this.csrfToken;
    return copy;
  }
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** Attend un e-mail (Mailpit) pour `to` dont l'objet contient `subject`, renvoie son texte. */
export async function waitForMail(to: string, subject: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await axios.get<{ messages: MailpitSummary[] }>(`${MAILPIT_URL}/api/v1/messages?limit=200`);
    const found = list.data.messages.find(
      (m) => m.To.some((t) => t.Address === to) && m.Subject.includes(subject),
    );
    if (found) {
      const message = await axios.get<{ Text: string; HTML: string }>(`${MAILPIT_URL}/api/v1/message/${found.ID}`);
      return message.data.Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Aucun e-mail « ${subject} » reçu`);
}

/** Attend au moins `count` e-mails pour `to` dont l'objet contient `subject`. */
export async function waitForMailCount(to: string, subject: string, count: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await axios.get<{ messages: MailpitSummary[] }>(`${MAILPIT_URL}/api/v1/messages?limit=200`);
    const found = list.data.messages.filter((m) => m.To.some((t) => t.Address === to) && m.Subject.includes(subject));
    if (found.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Moins de ${count} e-mails « ${subject} » reçus`);
}

/** Extrait le jeton d'un lien `…/chemin?token=…` du texte de l'e-mail. */
export function tokenFrom(text: string, path: string): string {
  const match = new RegExp(`${path.replace(/[/-]/g, '\\$&')}\\?token=([A-Za-z0-9_-]+)`).exec(text);
  if (!match?.[1]) throw new Error(`Lien ${path} introuvable dans l'e-mail`);
  return match[1];
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@exemple.fr`;
}

/**
 * Adresse d'un domaine jetable (liste anti-abus) : le compte reste en Gratuit à la vérification (pas
 * d'essai Pro, phase 6). Mailpit reçoit quand même l'e-mail.
 */
export function uniqueFreeEmail(prefix: string): string {
  return uniqueEmail(prefix).replace(/@exemple\.fr$/, '@mailinator.com');
}
