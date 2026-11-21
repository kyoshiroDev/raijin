/** Caractère d'ellipse utilisé pour tronquer les adresses. */
export const ELLIPSIS = '…';

/**
 * Tronque une adresse au milieu : `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU` → `7xKX…gAsU`.
 * Renvoie la chaîne intacte si elle est déjà assez courte.
 */
export function truncateMiddle(value: string, head = 4, tail = 4): string {
  const safeHead = Math.max(0, Math.floor(head));
  const safeTail = Math.max(0, Math.floor(tail));
  if (value.length <= safeHead + safeTail + 1) {
    return value;
  }
  return `${value.slice(0, safeHead)}${ELLIPSIS}${value.slice(value.length - safeTail)}`;
}
