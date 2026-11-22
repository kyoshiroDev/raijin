const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Convertit une durée lisible (`15m`, `24h`, `30d`, `500ms`, ou un nombre de secondes) en millisecondes.
 * Renvoie `null` si la valeur est invalide ou nulle.
 */
export function parseDuration(value: string): number | null {
  const match = /^\s*(\d+)\s*(ms|s|m|h|d)?\s*$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = UNITS[match[2] ?? 's'] ?? 1_000;
  const ms = amount * unit;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}
