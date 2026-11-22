import { createPrivateKey } from 'node:crypto';

/** Champs utiles du JSON d'un compte de service Google (le reste est ignoré, rien n'est conservé en plus). */
export interface ServiceAccountKey {
  readonly clientEmail: string;
  /** Clé privée PEM (PKCS#8). Jamais journalisée, jamais renvoyée. */
  readonly privateKey: string;
}

const CLIENT_EMAIL = /^[a-z0-9-]{1,63}@[a-z0-9-]{1,63}\.iam\.gserviceaccount\.com$/;

/** Accepte le JSON brut (une ligne) ou encodé en base64 (`base64 -w0 cle.json`). */
function decode(raw: string): unknown {
  const text = raw.trim();
  const candidates = text.startsWith('{') ? [text] : [Buffer.from(text, 'base64').toString('utf8'), text];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Essai suivant.
    }
  }
  return null;
}

/**
 * Lit le JSON du compte de service. `null` si illisible, si ce n'est pas un compte de service ou si la clé privée
 * n'est pas une clé RSA valide. Aucune valeur n'est jamais reprise dans une erreur ou un journal.
 */
export function parseServiceAccount(raw: string): ServiceAccountKey | null {
  const json = decode(raw);
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  const clientEmail = record['client_email'];
  const privateKey = record['private_key'];
  if (record['type'] !== undefined && record['type'] !== 'service_account') return null;
  if (typeof clientEmail !== 'string' || !CLIENT_EMAIL.test(clientEmail)) return null;
  if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) return null;
  try {
    const key = createPrivateKey(privateKey.replace(/\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'rsa') return null;
  } catch {
    return null;
  }
  return { clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') };
}
