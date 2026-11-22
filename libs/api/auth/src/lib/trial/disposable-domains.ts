import { DISPOSABLE_DOMAINS_GENERATED } from './disposable-domains.generated';
import { DISPOSABLE_DOMAINS_LOCAL_ADDITIONS, DISPOSABLE_DOMAINS_LOCAL_EXCEPTIONS } from './disposable-domains.local';

/** Liste effective : source CC0 + ajouts maison − exceptions maison (construite une fois, en mémoire). */
const EXCEPTIONS = new Set(DISPOSABLE_DOMAINS_LOCAL_EXCEPTIONS);
const DISPOSABLE = new Set([...DISPOSABLE_DOMAINS_GENERATED, ...DISPOSABLE_DOMAINS_LOCAL_ADDITIONS].filter((domain) => !EXCEPTIONS.has(domain)));

/** Domaine de l'adresse, en minuscules, sans point final ; `null` si l'adresse est mal formée. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '') || null;
}

/**
 * Vrai si le domaine **ou un domaine parent** (au moins deux labels) est jetable :
 * `x.mailinator.com` est refusé comme `mailinator.com`. Une exception maison ne couvre que son domaine exact.
 */
export function isDisposableDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  for (let start = 0; start <= labels.length - 2; start += 1) {
    const candidate = labels.slice(start).join('.');
    if (EXCEPTIONS.has(candidate)) return false;
    if (DISPOSABLE.has(candidate)) return true;
  }
  return false;
}

export function isDisposableEmail(email: string): boolean {
  const domain = emailDomain(email);
  return domain !== null && isDisposableDomain(domain);
}

/** Nombre de domaines de la liste effective (contrôle de cohérence, tests). */
export function disposableDomainCount(): number {
  return DISPOSABLE.size;
}
