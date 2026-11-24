import * as z from '../zod';
import { countSchema, ratioSchema } from './common';

/**
 * Santé technique (écran 9). Route : `GET admin/health` → `AdminHealth`. Remplace l'ancien `GET health/config`
 * public (mineur M3 de la phase 1) : l'état configuré / non configuré des services n'est plus lisible que par l'admin.
 * Alertes admin (e-mail + push à chaque compte ADMIN) : un job qui échoue `ADMIN_ALERT_JOB_FAILURES` fois de suite,
 * un quota qui dépasse `ADMIN_ALERT_QUOTA_RATIO` (docs/ARCHITECTURE.md §14.7).
 */
export const ADMIN_ALERT_DEFAULTS = { jobFailures: 3, quotaRatio: 0.8 } as const;

export const jobRunStatusSchema = z.enum(['running', 'success', 'failed']);
export type JobRunStatusValue = z.infer<typeof jobRunStatusSchema>;

const jobNameSchema = z.string().regex(/^[a-z0-9:_-]{1,64}$/);

export const adminJobHealthSchema = z.object({
  name: jobNameSchema,
  lastRunAt: z.iso.datetime().nullable(),
  lastStatus: jobRunStatusSchema.nullable(),
  lastDurationMs: z.number().int().min(0).nullable(),
  /** Échecs consécutifs depuis le dernier succès (alerte à `ADMIN_ALERT_DEFAULTS.jobFailures`). */
  consecutiveFailures: countSchema,
  /** Code d'erreur seulement (jamais de message ni de stack). */
  lastErrorCode: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).nullable(),
  /**
   * Prochaine exécution planifiée (BullMQ, planificateur du job) ; `null` si inconnue, jobs désactivés (`JOBS_ENABLED`)
   * ou job déclenché à la demande : l'écran affiche « — » avec l'explication.
   */
  nextRunAt: z.iso.datetime().nullable(),
});
export type AdminJobHealth = z.infer<typeof adminJobHealthSchema>;

/** Consommations suivies : crédits Helius (global et par voie) et appels aux API publiques, par jour UTC. */
export const QUOTA_SERVICES = [
  'helius',
  'helius_watch',
  'helius_wallet',
  'jupiter',
  'rugcheck',
  'dexscreener',
  'geckoterminal',
] as const;
export const quotaServiceSchema = z.enum(QUOTA_SERVICES);
export type QuotaService = z.infer<typeof quotaServiceSchema>;

export const QUOTA_SERVICE_LABELS: Readonly<Record<QuotaService, string>> = {
  helius: 'Helius (crédits, total)',
  helius_watch: 'Helius (suivis)',
  helius_wallet: 'Helius (scans de wallet)',
  jupiter: 'Jupiter (devis)',
  rugcheck: 'RugCheck',
  dexscreener: 'DexScreener',
  geckoterminal: 'GeckoTerminal',
};

export const quotaLevelSchema = z.enum(['ok', 'warning', 'critical']);
export type QuotaLevel = z.infer<typeof quotaLevelSchema>;

/** `warning` dès `quotaRatio` (80 %), `critical` à 100 % ; `ok` si aucune limite connue. */
export function quotaLevel(ratio: number | null, threshold: number = ADMIN_ALERT_DEFAULTS.quotaRatio): QuotaLevel {
  if (ratio === null) return 'ok';
  if (ratio >= 1) return 'critical';
  return ratio >= threshold ? 'warning' : 'ok';
}

export const adminQuotaUsageSchema = z.object({
  service: quotaServiceSchema,
  period: z.literal('day'),
  used: countSchema,
  /** `null` si la limite n'est pas connue (appels comptés sans plafond configuré). */
  limit: countSchema.nullable(),
  /** used / limit (peut dépasser 1) ; `null` sans limite. */
  ratio: z.number().min(0).nullable(),
  level: quotaLevelSchema,
});
export type AdminQuotaUsage = z.infer<typeof adminQuotaUsageSchema>;

export const ADMIN_ALERT_KINDS = ['job_failing', 'quota_threshold'] as const;
export const adminAlertKindSchema = z.enum(ADMIN_ALERT_KINDS);
export type AdminAlertKind = z.infer<typeof adminAlertKindSchema>;

export const ADMIN_ALERT_KIND_LABELS: Readonly<Record<AdminAlertKind, string>> = {
  job_failing: 'Job en échec répété',
  quota_threshold: 'Quota presque atteint',
};

export const adminAlertSchema = z.object({
  id: z.uuid(),
  kind: adminAlertKindSchema,
  /** Nom du job ou du service concerné. */
  subject: z.string().regex(/^[a-z0-9:_-]{1,64}$/),
  level: z.enum(['warning', 'critical']),
  details: z.object({
    consecutiveFailures: countSchema.optional(),
    lastErrorCode: z.string().max(64).optional(),
    used: countSchema.optional(),
    limit: countSchema.optional(),
    ratio: z.number().min(0).optional(),
  }),
  createdAt: z.iso.datetime(),
  /** Envoi e-mail + push fait ; `null` si l'envoi a échoué (réessayé au passage suivant). */
  notifiedAt: z.iso.datetime().nullable(),
  /** Retour à la normale constaté (job réussi, nouveau jour UTC). */
  resolvedAt: z.iso.datetime().nullable(),
});
export type AdminAlert = z.infer<typeof adminAlertSchema>;

export const serviceConfigStateSchema = z.enum(['configured', 'not_configured']);

export const adminHealthSchema = z.object({
  generatedAt: z.iso.datetime(),
  jobs: z.array(adminJobHealthSchema).max(50),
  quotas: z.array(adminQuotaUsageSchema).max(QUOTA_SERVICES.length),
  api: z.object({
    window: z.literal('24h'),
    requests: countSchema,
    serverErrors: countSchema,
    errorRate: ratioSchema.nullable(),
    /**
     * `true` si `requests` / `serverErrors` sont reconstitués (part au prorata du jour UTC précédent) et non comptés sur
     * une fenêtre glissante exacte : l'écran affiche alors « estimé » à côté du taux.
     */
    estimated: z.boolean().default(true),
  }),
  emails: z.object({ provider: z.enum(['smtp', 'resend']), sent24h: countSchema, failed24h: countSchema }),
  push: z.object({ provider: z.enum(['webpush', 'fake', 'unavailable']), activeSubscriptions: countSchema }),
  database: z.object({ sizeBytes: countSchema.nullable() }),
  /** Services externes configurés ou non (jamais de valeur ni d'extrait) : ex-`GET health/config`. */
  services: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), serviceConfigStateSchema),
  /** Alertes ouvertes puis récentes (20 au plus). */
  alerts: z.array(adminAlertSchema).max(20),
});
export type AdminHealth = z.infer<typeof adminHealthSchema>;

/** Libellé d'un job (texte maîtrisé par Raijin) ; le front affiche le nom brut pour un job inconnu. */
export const ADMIN_JOB_LABELS: Readonly<Record<string, string>> = {
  'watch-planner': 'Réanalyse des suivis',
  purge: 'Purge quotidienne',
  'trial-tick': 'Fin d’essai et e-mails d’essai',
  'weekly-digest': 'Résumé hebdomadaire',
  'metrics-aggregate': 'Agrégats nocturnes',
  'admin-alerts': 'Alertes admin',
};
