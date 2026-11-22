import * as z from '../zod';

/** Fichier commun des contrats admin : textes externes, compteurs, périodes, KPI, séries, répartitions. */

// Caractères de contrôle (C0, DEL, C1) : refusés dans tout texte venu de l'extérieur (Google, UTM, métadonnées).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Texte venu de l'extérieur (requête Search Console, titre de page GA4, source UTM, symbole de token) :
 * **hostile**, borné, sans caractère de contrôle. Le front l'affiche par interpolation Angular (jamais `innerHTML`).
 */
export function externalText(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => !CONTROL_CHARS.test(value), { message: 'Texte invalide.' });
}

/** Nombre de lignes maximal des classements (pages, requêtes, sources…). */
export const ADMIN_TOP_ROWS_MAX = 25;

export const countSchema = z.number().int().min(0);
export const ratioSchema = z.number().min(0).max(1);
/** Montant en centimes entiers (devise de `BILLING_CURRENCY`). */
export const centsSchema = z.number().int().min(0);

// ---------------------------------------------------------------------------------------------
// Périodes
// ---------------------------------------------------------------------------------------------

/**
 * Périodes de l'admin, en **jours UTC** (même découpage que `DailyMetric.date`). `today` = jour UTC en cours
 * (calculé en direct, mis en cache 60 s) ; les autres se terminent aujourd'hui inclus. La période précédente a la
 * même longueur et se termine la veille du début de la période courante.
 */
export const ADMIN_PERIODS = ['today', '7d', '30d', '90d'] as const;
export const adminPeriodSchema = z.enum(ADMIN_PERIODS);
export type AdminPeriod = z.infer<typeof adminPeriodSchema>;

export const ADMIN_PERIOD_LABELS: Readonly<Record<AdminPeriod, string>> = {
  today: 'Aujourd’hui',
  '7d': '7 jours',
  '30d': '30 jours',
  '90d': '90 jours',
};

/** Longueur maximale d'une période personnalisée (`from` → `to` inclus). */
export const ADMIN_CUSTOM_RANGE_MAX_DAYS = 366;

const DAY_MS = 86_400_000;

/** Nombre de jours de `from` à `to` inclus (dates ISO `YYYY-MM-DD`). */
export function daysInRange(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/**
 * Requête de période (`?period=7d` ou `?from=2026-11-01&to=2026-11-21`). `from`/`to` vont ensemble et priment sur
 * `period`. Les clés inconnues sont ignorées (paramètres de requête).
 */
export const adminRangeQueryShape = {
  period: adminPeriodSchema.default('7d'),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};

function refineRange(value: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  if ((value.from === undefined) !== (value.to === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Indique une date de début et une date de fin.', path: ['from'] });
    return;
  }
  if (value.from !== undefined && value.to !== undefined) {
    const days = daysInRange(value.from, value.to);
    if (days < 1 || days > ADMIN_CUSTOM_RANGE_MAX_DAYS) {
      ctx.addIssue({ code: 'custom', message: 'Période invalide (366 jours au plus).', path: ['to'] });
    }
  }
}

export const adminRangeQuerySchema = z.object(adminRangeQueryShape).superRefine(refineRange);
export type AdminRangeQuery = z.infer<typeof adminRangeQuerySchema>;

/** Ajoute la validation de période à un objet de requête qui étend `adminRangeQueryShape`. */
export function withRangeRefinement<T extends z.ZodObject>(schema: T) {
  return schema.superRefine((value, ctx) => refineRange(value as { from?: string; to?: string }, ctx));
}

export const dateRangeSchema = z.object({ from: z.iso.date(), to: z.iso.date() });
export type DateRange = z.infer<typeof dateRangeSchema>;

/** Période résolue par l'API (toujours renvoyée : le front n'a aucun calcul de dates à faire). */
export const resolvedRangeSchema = z.object({
  period: z.union([adminPeriodSchema, z.literal('custom')]),
  current: dateRangeSchema,
  previous: dateRangeSchema,
  /** Toujours `UTC` en v1 (jours de `DailyMetric`). */
  timezone: z.literal('UTC'),
});
export type ResolvedRange = z.infer<typeof resolvedRangeSchema>;

// ---------------------------------------------------------------------------------------------
// Valeurs, variations, séries
// ---------------------------------------------------------------------------------------------

/** Unité d'une métrique : le front choisit le formatage (`Intl` fr-FR), jamais l'API. */
export const METRIC_UNITS = ['count', 'cents', 'ratio', 'ms', 'bytes', 'position', 'seconds'] as const;
export const metricUnitSchema = z.enum(METRIC_UNITS);
export type MetricUnit = z.infer<typeof metricUnitSchema>;

/**
 * Variation relative entre deux périodes (0,12 = +12 %). `null` si une valeur manque ou si la période précédente
 * vaut 0 (variation non définie : le front affiche « nouveau » ou un tiret).
 */
export function computeChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  return (current - previous) / Math.abs(previous);
}

/** Origine d'une donnée : agrégats internes (`DailyMetric`, base) ou Google Analytics 4. */
export const metricSourceSchema = z.enum(['internal', 'ga4']);
export type MetricSource = z.infer<typeof metricSourceSchema>;

/**
 * État d'une valeur : `ok`, `not_connected` (service Google non configuré : « Non connecté »), `unavailable`
 * (service en erreur ou agrégat pas encore calculé). Hors `ok`, `value` vaut `null`.
 */
export const metricStatusSchema = z.enum(['ok', 'not_connected', 'unavailable']);
export type MetricStatus = z.infer<typeof metricStatusSchema>;

const finite = z.number().refine(Number.isFinite, { message: 'Nombre invalide.' });

export const timeSeriesPointSchema = z.object({
  date: z.iso.date(),
  /** `null` = donnée absente ce jour-là (trou dans la courbe, jamais 0 inventé). */
  value: finite.nullable(),
});
export type TimeSeriesPoint = z.infer<typeof timeSeriesPointSchema>;

/** Points au plus dans une série (366 jours + marge). */
export const TIME_SERIES_MAX_POINTS = 400;

/** Série temporelle journalière, triée par date croissante, un point par jour de la période. */
export const timeSeriesSchema = z.object({
  key: z.string().regex(/^[a-z0-9_.]{1,64}$/),
  unit: metricUnitSchema,
  points: z.array(timeSeriesPointSchema).max(TIME_SERIES_MAX_POINTS),
  /** Période précédente alignée jour par jour (même longueur), tracée en `info`. Absente si non demandée. */
  comparison: z.array(timeSeriesPointSchema).max(TIME_SERIES_MAX_POINTS).optional(),
});
export type TimeSeries = z.infer<typeof timeSeriesSchema>;

/** Ligne d'une répartition (canal, appareil, verdict…) : `share` = part du total (0 à 1). */
export const breakdownRowSchema = z.object({
  key: externalText(200),
  value: finite.min(0),
  share: ratioSchema.nullable(),
});
export type BreakdownRow = z.infer<typeof breakdownRowSchema>;
