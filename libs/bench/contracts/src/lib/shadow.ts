import { mintAddressSchema } from '@raijin/shared-contracts';
import * as z from './zod';
import { countSchema, isoDateTimeSchema, isoDaySchema } from './common';

/**
 * Comparaison du mode ombre (docs/ARCHITECTURE.md §17.6) : `public` (collecte du VPS) contre
 * `shadow_ref` (instantané Supabase copié par `infra/bench-migrate.sh --shadow-snapshot`, lancé
 * par l'utilisateur). L'API n'a aucun accès à Supabase : elle ne lit que `raijin_bench`.
 */
/**
 * Tables copiées dans `shadow_ref` (même liste que `SHADOW_REF_DAY_COLUMNS` de `@raijin/bench-prisma`,
 * qui fixe la colonne de date de chaque table). Les issues sont `signal_outcomes` et `preset_signals`.
 */
export const SHADOW_TABLES = [
  'tokens',
  'token_snapshots',
  'scan_runs',
  'alert_log',
  'paper_positions',
  'signal_outcomes',
  'preset_signals',
] as const;
export const shadowTableSchema = z.enum(SHADOW_TABLES);
export type ShadowTable = z.infer<typeof shadowTableSchema>;

/** Fenêtre comparée : 31 jours au plus. */
export const SHADOW_WINDOW_MAX_DAYS = 31;
export const SHADOW_MINT_SAMPLE_MAX = 20;

/** `GET /api/shadow/comparison?from=&to=&table=`. */
export const shadowComparisonQuerySchema = z
  .object({
    from: isoDaySchema,
    to: isoDaySchema,
    table: shadowTableSchema.optional(),
  })
  .refine((q) => q.from <= q.to, {
    message: 'La date de début doit précéder la date de fin.',
    path: ['to'],
  })
  .refine(
    (q) =>
      Date.parse(q.to) - Date.parse(q.from) <=
      SHADOW_WINDOW_MAX_DAYS * 86_400_000,
    {
      message: `Fenêtre de ${SHADOW_WINDOW_MAX_DAYS} jours au plus.`,
      path: ['to'],
    },
  );
export type ShadowComparisonQuery = z.infer<typeof shadowComparisonQuerySchema>;

export const shadowDayRowSchema = z.object({
  table: shadowTableSchema,
  day: isoDaySchema,
  vps_rows: countSchema,
  ref_rows: countSchema,
  /** (vps − ref) / ref en POURCENT ; `null` quand `ref_rows` vaut 0. */
  diff_pct: z.number().nullable(),
  /** Mints présents d'un seul côté (tables qui ont une colonne `mint`) : nombre et échantillon. */
  only_vps_count: countSchema.nullable(),
  only_ref_count: countSchema.nullable(),
  only_vps_sample: z.array(mintAddressSchema).max(SHADOW_MINT_SAMPLE_MAX),
  only_ref_sample: z.array(mintAddressSchema).max(SHADOW_MINT_SAMPLE_MAX),
});
export type ShadowDayRow = z.infer<typeof shadowDayRowSchema>;

export const shadowComparisonSchema = z.object({
  /** Date de l'instantané `shadow_ref` (`null` : aucun instantané importé). */
  snapshot_at: isoDateTimeSchema.nullable(),
  /**
   * Fenêtre `[from ; to[` copiée par ce dernier instantané (`--since` / `--until` de `bench-migrate.sh`,
   * `shadow_ref.snapshot_meta`) ; `null` sans instantané. Seuls les jours UTC entièrement couverts
   * comptent pour les seuils de bascule (`evaluateShadowAcceptance`).
   */
  snapshot_window: z
    .object({ from: isoDateTimeSchema, to: isoDateTimeSchema })
    .nullable(),
  from: isoDaySchema,
  to: isoDaySchema,
  rows: z
    .array(shadowDayRowSchema)
    .max(SHADOW_TABLES.length * (SHADOW_WINDOW_MAX_DAYS + 1)),
});
export type ShadowComparison = z.infer<typeof shadowComparisonSchema>;
