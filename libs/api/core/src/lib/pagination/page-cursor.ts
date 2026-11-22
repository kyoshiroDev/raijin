import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../errors/api-exception';

/** Position d'une ligne dans un tri `createdAt DESC, id DESC`. */
export interface PageCursorPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/** Curseur opaque base64url de `createdAt` + `id` (ordre décroissant), contrat `pageCursorSchema`. */
export function encodePageCursor(row: PageCursorPosition): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

/** Décode un curseur ; `null` s'il est mal formé. */
export function decodePageCursor(cursor: string): PageCursorPosition | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, id, extra] = raw.split('|');
  if (extra !== undefined || !iso || !id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const createdAt = new Date(iso);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

/** Condition Prisma « strictement après le curseur » (tri décroissant) ; 400 si le curseur est invalide. */
export function afterCursor(cursor: string | undefined): { OR: Array<Record<string, unknown>> } | undefined {
  if (!cursor) return undefined;
  const position = decodePageCursor(cursor);
  if (!position) throw new ApiException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST, 'Curseur invalide.');
  return { OR: [{ createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { lt: position.id } }] };
}
