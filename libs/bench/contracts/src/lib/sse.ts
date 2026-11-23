import { mintAddressSchema } from '@raijin/shared-contracts';
import * as z from './zod';
import { fractionSchema, isoDateTimeSchema, rowIdSchema } from './common';
import { jobRunSchema } from './jobs';
import { runStatusSchema } from './lab';
import { paperBookSchema } from './paper';
import { tokenRowSchema } from './tokens';

/**
 * Flux SSE du banc (remplace Supabase Realtime) : `GET /api/events` (session, `text/event-stream`,
 * ni compression ni tampon côté Traefik). Chaque message : `event: <type>` et `data: <JSON>`
 * conforme à `benchEventSchema`. Battement toutes les 25 s ; le front se reconnecte (EventSource)
 * puis recharge ses listes (aucun rejeu d'événements manqués).
 */
export const BENCH_SSE_PATH = '/api/events';
export const BENCH_SSE_HEARTBEAT_SECONDS = 25;

export const BENCH_EVENT_TYPES = ['heartbeat', 'token.upsert', 'token.delete', 'paper.changed', 'job.finished', 'backtest.progress'] as const;
export const benchEventTypeSchema = z.enum(BENCH_EVENT_TYPES);
export type BenchEventType = z.infer<typeof benchEventTypeSchema>;

export const benchEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heartbeat'), at: isoDateTimeSchema }),
  /** Token inséré ou mis à jour par le scan / l'enrichissement (ex-`tokens-live`). */
  z.object({ type: z.literal('token.upsert'), token: tokenRowSchema }),
  z.object({ type: z.literal('token.delete'), mint: mintAddressSchema }),
  /** Position, jambe ou portefeuille modifié (ex-`paper-positions-live`) : le front recharge. */
  z.object({ type: z.literal('paper.changed'), book: paperBookSchema, position_id: rowIdSchema.nullable() }),
  z.object({ type: z.literal('job.finished'), run: jobRunSchema }),
  z.object({ type: z.literal('backtest.progress'), run_id: rowIdSchema, status: runStatusSchema, progress: fractionSchema }),
]);
export type BenchEvent = z.infer<typeof benchEventSchema>;
