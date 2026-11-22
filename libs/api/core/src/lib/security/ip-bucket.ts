/**
 * Préfixe d'adresse utilisé pour l'empreinte : IPv4 complète, IPv6 limitée à son /64 (un abonné
 * dispose en général d'un /64 entier : sans cette troncature, changer d'adresse dans le même
 * réseau suffirait à remettre le quota anonyme à zéro). Les IPv4 embarquées redeviennent des IPv4 :
 * mappées (`::ffff:a.b.c.d`, `::ffff:7f00:1`) et NAT64 (`64:ff9b::/96`), sinon tous les clients
 * passant par la même passerelle partageraient un seul /64.
 */
export function ipBucket(ip: string | null): string {
  if (!ip) return 'unknown';
  const value = ip.trim().toLowerCase();
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (dotted?.[1] && dotted[2]) {
    // Forme pointée finale (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) : convertie en deux groupes hexadécimaux.
    const [a = 0, b = 0, c = 0, d = 0] = dotted[2].split('.').map(Number);
    return ipBucket(`${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`);
  }
  if (!value.includes(':')) return value;
  const [head = '', tail = ''] = value.split('%')[0]?.split('::') ?? [];
  const left = head ? head.split(':') : [];
  const right = value.includes('::') && tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = value.includes('::') ? [...left, ...Array<string>(missing).fill('0'), ...right] : left;
  const embedded = embeddedIpv4(groups);
  if (embedded) return embedded;
  return `${groups
    .slice(0, 4)
    .map((group) => (group.replace(/^0+(?=.)/, '') || '0'))
    .join(':')}::/64`;
}

/** IPv4 contenue dans une IPv6 mappée (`::ffff:0:0/96`) ou NAT64 (`64:ff9b::/96`), sinon `null`. */
function embeddedIpv4(groups: readonly string[]): string | null {
  if (groups.length !== 8) return null;
  const n = groups.map((group) => parseInt(group || '0', 16));
  if (n.some((value) => Number.isNaN(value))) return null;
  const mapped = n.slice(0, 5).every((value) => value === 0) && n[5] === 0xffff;
  const nat64 = n[0] === 0x64 && n[1] === 0xff9b && n.slice(2, 6).every((value) => value === 0);
  if (!mapped && !nat64) return null;
  const high = n[6] ?? 0;
  const low = n[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}
