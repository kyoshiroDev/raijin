import { z } from 'zod';

/** Verdict global d'une analyse : Sain, Prudence ou Danger. */
export const verdictSchema = z.enum(['safe', 'warn', 'danger']);
export type Verdict = z.infer<typeof verdictSchema>;

/** Libellés français des verdicts (toujours affichés avec une icône, jamais la couleur seule). */
export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  safe: 'Sain',
  warn: 'Prudence',
  danger: 'Danger',
};

/** Statut d'un contrôle individuel de l'analyse. */
export const checkStatusSchema = z.enum(['ok', 'warn', 'danger', 'unavailable']);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

/** Libellés français des statuts de contrôle. */
export const CHECK_STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  ok: 'OK',
  warn: 'Attention',
  danger: 'Danger',
  unavailable: 'Indisponible',
};
