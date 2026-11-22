const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Forme canonique anti-abus d'une adresse (champ `emailNormalized`, unique) :
 * minuscules, sans espaces ; alias `+…` retiré ; pour Gmail, points du nom retirés et
 * `googlemail.com` ramené à `gmail.com`. Jamais utilisée comme adresse d'envoi.
 */
export function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return value;
  let local = value.slice(0, at);
  let domain = value.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }
  return `${local}@${domain}`;
}
