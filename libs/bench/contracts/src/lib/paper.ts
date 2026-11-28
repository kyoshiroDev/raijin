import { mintAddressSchema } from '@raijin/shared-contracts';
import * as z from './zod';
import { externalTextSchema, isoDateTimeSchema, listResponseSchema, rowIdSchema } from './common';

/**
 * Paper trading du banc (SIMULATION UNIQUEMENT : aucun wallet, aucune clé, aucune signature, aucun
 * ordre réel). Remplace les lectures de `paper_wallets` / `paper_positions` / `paper_legs` et les
 * RPC `paper_open_position`, `paper_cancel_position`, `paper_reset_wallet` : l'API revérifie tout
 * dans une transaction Prisma (statut, solde, carnet, bornes).
 */

/** Carnets lus par le front : principal, 3 carnets de test, 2 carnets archivés (lecture seule). */
export const PAPER_BOOKS = ['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30', 'calm_all_x2', 'frenzy_all_x2'] as const;
export const paperBookSchema = z.enum(PAPER_BOOKS);
export type PaperBook = z.infer<typeof paperBookSchema>;
export const ARCHIVED_PAPER_BOOKS: readonly PaperBook[] = ['calm_all_x2', 'frenzy_all_x2'];
export const TEST_PAPER_BOOKS: readonly PaperBook[] = ['calm_sl30', 'calm_sl40', 'frenzy_sl30'];

export const paperStrategySchema = z.enum(['half_x2_rest_x3', 'all_x2', 'thirds_x2_x3_x4', 'custom']);
export type PaperStrategy = z.infer<typeof paperStrategySchema>;
/** Seule stratégie ouvrable aujourd'hui (les autres restent lisibles dans l'historique). */
export const OPENABLE_PAPER_STRATEGY = 'all_x2' satisfies PaperStrategy;
export const paperSourceSchema = z.enum(['manual', 'auto_alert']);
export const positionStatusSchema = z.enum(['pending', 'open', 'closed', 'cancelled', 'expired']);
export type PositionStatus = z.infer<typeof positionStatusSchema>;
export const legStatusSchema = z.enum(['open', 'tp_hit', 'sl_hit', 'breakeven_hit']);
export const legSizePctSchema = z.union([z.literal(33), z.literal(34), z.literal(50), z.literal(100)]);

const price = z.number().positive();

export const paperWalletSchema = z.object({
  book: paperBookSchema,
  balance_sol: z.number(),
  initial_sol: z.number().nonnegative(),
  created_at: isoDateTimeSchema.nullable(),
  reset_at: isoDateTimeSchema.nullable(),
});
export type PaperWallet = z.infer<typeof paperWalletSchema>;

export const paperLegSchema = z.object({
  id: rowIdSchema,
  position_id: rowIdSchema,
  size_pct: legSizePctSchema,
  tp_price: price.nullable(),
  stop_price: price.nullable(),
  status: legStatusSchema,
  exit_price: price.nullable(),
  closed_at: isoDateTimeSchema.nullable(),
});
export type PaperLeg = z.infer<typeof paperLegSchema>;

export const paperPositionSchema = z.object({
  id: rowIdSchema,
  book: paperBookSchema,
  mint: mintAddressSchema,
  symbol: externalTextSchema(64),
  strategy: paperStrategySchema,
  stake_sol: z.number().positive(),
  source: paperSourceSchema,
  status: positionStatusSchema,
  entry_target_price: price,
  fill_price: price.nullable(),
  sl_price: price.nullable(),
  sl_pct: z.number().nullable(),
  custom_tp_price: price.nullable(),
  expires_at: isoDateTimeSchema.nullable(),
  created_at: isoDateTimeSchema,
  filled_at: isoDateTimeSchema.nullable(),
  closed_at: isoDateTimeSchema.nullable(),
  pnl_sol: z.number().nullable(),
  fees_sol: z.number().nullable(),
  /** Triées par TP croissant (jambe A d'abord). */
  legs: z.array(paperLegSchema).max(3),
});
export type PaperPosition = z.infer<typeof paperPositionSchema>;

/** `GET /api/paper/wallets?books=` → `{ items }`. */
export const paperWalletsResponseSchema = listResponseSchema(paperWalletSchema, PAPER_BOOKS.length);

const bookList = z
  .string()
  .transform((value) => value.split(',').filter((b) => b.length > 0))
  .pipe(z.array(paperBookSchema).min(1).max(PAPER_BOOKS.length));

export const PAPER_POSITIONS_LIMIT_MAX = 500;
/** `GET /api/paper/positions?books=&status=&mint=&since=&limit=` : plus récentes d'abord, jambes incluses. */
export const paperPositionsQuerySchema = z.object({
  books: bookList.optional(),
  status: positionStatusSchema.optional(),
  mint: mintAddressSchema.optional(),
  since: isoDateTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PAPER_POSITIONS_LIMIT_MAX).default(200),
});
export type PaperPositionsQuery = z.infer<typeof paperPositionsQuerySchema>;
export const paperPositionsResponseSchema = listResponseSchema(paperPositionSchema, PAPER_POSITIONS_LIMIT_MAX);

/** `POST /api/paper/positions` (CSRF) → 201 `PaperPosition` ; 422 `PAPER_REJECTED`. Ex-`paper_open_position`. */
export const paperOpenRequestSchema = z
  .object({
    mint: mintAddressSchema,
    strategy: paperStrategySchema,
    stake_sol: z.number().min(0.01).max(100),
    entry_price: price,
    sl_pct: z.number().int().min(1).max(90).default(30),
    custom_tp_price: price.nullable().default(null),
    custom_sl_price: price.nullable().default(null),
    book: paperBookSchema.default('main'),
  })
  .strict();
export type PaperOpenRequest = z.infer<typeof paperOpenRequestSchema>;

/** `POST /api/paper/positions/:id/cancel` (CSRF) → `PaperPosition` (position `pending` seulement). */
export const paperPositionParamsSchema = z.object({ id: rowIdSchema });
/** `POST /api/paper/wallets/:book/reset` (CSRF) → `PaperWallet` (refusé sur un carnet archivé). */
export const paperWalletParamsSchema = z.object({ book: paperBookSchema });
