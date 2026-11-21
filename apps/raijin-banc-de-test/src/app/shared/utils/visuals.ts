// Pure geometry / formatting helpers for the visual primitives (sparkline, avatar, compact price).
// No Angular here: everything is unit-tested in visuals.spec.ts.

const positive = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

const INT_FR = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** « +45 % » / « −30 % » (U+2212) / « 0 % », rounded to the unit. */
export function signedPctInt(value: number): string {
  const r = Math.round(value);
  const sign = r > 0 ? '+' : r < 0 ? '−' : '';
  return `${sign}${INT_FR.format(Math.abs(r))} %`;
}

// ───────────────────────── Sparkline ─────────────────────────

export interface SparklineGeometry {
  /** Polyline points « x,y x,y … » in a width × height box. */
  points: string;
  /** Closed area path under the line (for the low-opacity fill). */
  area: string;
  /** last ≥ first. */
  up: boolean;
  /** Change between the first and the last point, in %. */
  changePct: number;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Sparkline geometry in a `width` × `height` viewBox (y grows downward, `pad` keeps the stroke inside).
 * Needs ≥ 2 positive finite points (others are ignored); null otherwise. A flat series is drawn mid-height.
 */
export function sparklineGeometry(values: readonly number[] | null | undefined, width = 100, height = 32, pad = 2): SparklineGeometry | null {
  const pts = (values ?? []).filter(positive);
  if (pts.length < 2) return null;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const innerH = height - 2 * pad;
  const step = width / (pts.length - 1);
  const coords = pts.map((p, i) => {
    const y = hi === lo ? height / 2 : pad + (1 - (p - lo) / (hi - lo)) * innerH;
    return [round2(i * step), round2(y)] as const;
  });
  const points = coords.map(([x, y]) => `${x},${y}`).join(' ');
  const area = `M0,${height} L${coords.map(([x, y]) => `${x},${y}`).join(' L')} L${round2(width)},${height} Z`;
  const first = pts[0];
  const last = pts[pts.length - 1];
  return { points, area, up: last >= first, changePct: (last / first - 1) * 100 };
}

// ───────────────────────── Avatar fallback ─────────────────────────

/** Deterministic hue 0–359 from the mint (FNV-1a 32 bits); null for an empty mint. */
export function mintHue(mint: string): number | null {
  if (!mint) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < mint.length; i++) {
    h ^= mint.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

/** Dark background colour for the generated avatar (light text stays ≥ AA on every hue). */
export function avatarBackground(mint: string): string | null {
  const hue = mintHue(mint);
  return hue === null ? null : `hsl(${hue} 45% 24%)`;
}

const AVATAR_CHAR = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/**
 * First letter / digit / emoji of the symbol, uppercased; « ? » when there is none (e.g. « <$> »).
 * Hostile text: the result is a single code point rendered through interpolation only.
 */
export function avatarLetter(symbol: string): string {
  for (const ch of Array.from(symbol ?? '')) {
    if (AVATAR_CHAR.test(ch)) return ch.toUpperCase();
  }
  return '?';
}

// ───────────────────────── Compact price ─────────────────────────

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

/**
 * Card price on one line at 375 px: below $0.0001 the run of leading zeros becomes a subscript count
 * (« $0.0₈1234 » = $0.000000001234, 4 significant digits, as on DexScreener); otherwise formatPrice-like.
 * Visual only: pair it with the full price as screen-reader text. '–' when unknown.
 */
export function formatPriceCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '–';
  if (value >= 1) return `$${value.toFixed(3)}`;
  if (value >= 0.0001) return `$${value.toFixed(Math.min(12, Math.max(2, -Math.floor(Math.log10(value)) + 3)))}`;
  let zeros = -Math.floor(Math.log10(value)) - 1;
  let digits = Math.round(value * 10 ** (zeros + 4));
  if (digits >= 10_000) {
    // rounding carried over (e.g. 0.000099999 → 0.0001000)
    digits = Math.round(digits / 10);
    zeros -= 1;
  }
  const sub = Array.from(String(zeros), (d) => SUBSCRIPT_DIGITS[Number(d)]).join('');
  const sig = String(digits).replace(/0+$/, '');
  return `$0.0${sub}${sig === '' ? '0' : sig}`;
}
