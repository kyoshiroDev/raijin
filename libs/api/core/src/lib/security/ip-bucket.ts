/**
 * Préfixe d'adresse utilisé pour l'empreinte : IPv4 complète, IPv6 limitée à son /64 (un abonné
 * dispose en général d'un /64 entier : sans cette troncature, changer d'adresse dans le même
 * réseau suffirait à remettre le quota anonyme à zéro). Les IPv4 mappées (`::ffff:a.b.c.d`)
 * redeviennent des IPv4.
 */
export function ipBucket(ip: string | null): string {
  if (!ip) return 'unknown';
  const value = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped?.[1]) return mapped[1];
  if (!value.includes(':')) return value;
  const [head = '', tail = ''] = value.split('%')[0]?.split('::') ?? [];
  const left = head ? head.split(':') : [];
  const right = value.includes('::') && tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = value.includes('::') ? [...left, ...Array<string>(missing).fill('0'), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((group) => (group.replace(/^0+(?=.)/, '') || '0'))
    .join(':')}::/64`;
}
