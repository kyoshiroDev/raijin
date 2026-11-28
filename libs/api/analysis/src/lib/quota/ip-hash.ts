import { hmac, ipBucket } from '@raijin/api-core';

export { ipBucket };

/** Empreinte HMAC-SHA-256 tronquée de l'IP (jamais stockée ni journalisée en clair). */
export function hashIp(secret: string, ip: string | null): string {
  return hmac(secret, `ip:${ipBucket(ip)}`).slice(0, 32);
}
