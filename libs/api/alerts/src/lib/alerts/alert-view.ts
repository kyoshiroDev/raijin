import type { AlertMessage } from '@raijin/api-notifications';
import { alertEventSchema, alertSchema, type Alert } from '@raijin/shared-contracts';
import { parseToken } from '../watch/snapshot';

/** Colonnes d'une alerte nécessaires à l'affichage et aux envois. */
export interface AlertRow {
  readonly id: string;
  readonly mint: string;
  readonly type: string;
  readonly severity: 'warn' | 'danger';
  readonly payload: unknown;
  readonly token: unknown;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export const alertRowSelect = {
  id: true,
  mint: true,
  type: true,
  severity: true,
  payload: true,
  token: true,
  readAt: true,
  createdAt: true,
} as const;

/** Ligne → contrat `Alert` (garde de sortie : une ligne hors contrat n'est jamais renvoyée). */
export function toAlert(row: AlertRow): Alert | null {
  const parsed = alertSchema.safeParse({
    id: row.id,
    mint: row.mint,
    token: parseToken(row.token),
    severity: row.severity,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    type: row.type,
    payload: row.payload,
  });
  return parsed.success ? parsed.data : null;
}

/** Ligne → message des e-mails et du push (texte nettoyé). */
export function toAlertMessage(row: AlertRow): AlertMessage | null {
  const event = alertEventSchema.safeParse({ type: row.type, payload: row.payload });
  if (!event.success) return null;
  return { ...event.data, id: row.id, mint: row.mint, severity: row.severity, token: parseToken(row.token), createdAt: row.createdAt };
}

/** Curseur opaque base64url de `createdAt` + `id` (ordre décroissant). */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, id] = raw.split('|');
  if (!iso || !id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const createdAt = new Date(iso);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}
