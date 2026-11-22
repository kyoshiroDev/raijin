import * as z from '../zod';
import { pageQueryShape, pageResponseSchema } from '../pagination';
import { externalText } from './common';

/**
 * Journal d'audit (table `AuditLog` : `userId` = compte visé, `actorId` = auteur). Toute action admin y est écrite
 * **dans la même transaction** que la modification, avec l'état avant / après (docs/ARCHITECTURE.md §14.8).
 * Jamais d'e-mail, d'IP en clair, de secret ni de code dans `metadata`.
 * Route : `GET admin/audit-logs?userId=…&action=…&cursor=…` → `AdminAuditLogPage`.
 */
export const ADMIN_AUDIT_ACTIONS = [
  // Rôle (CLI uniquement)
  'admin.role_granted',
  'admin.role_revoked',
  'admin.2fa_reset',
  // Sécurité de la session admin
  'admin.2fa_enrolled',
  'admin.2fa_verified',
  'admin.2fa_failed',
  'admin.recovery_code_used',
  'admin.recovery_codes_regenerated',
  'admin.session_ended',
  // Consultation de données personnelles
  'admin.user_searched',
  'admin.user_viewed',
  // Actions sur un compte
  'admin.trial_extended',
  'admin.pro_month_granted',
  'admin.user_suspended',
  'admin.user_reactivated',
  'admin.verification_resent',
  'admin.user_deleted',
] as const;
export const adminAuditActionSchema = z.enum(ADMIN_AUDIT_ACTIONS);
export type AdminAuditAction = z.infer<typeof adminAuditActionSchema>;

export const ADMIN_AUDIT_ACTION_LABELS: Readonly<Record<AdminAuditAction, string>> = {
  'admin.role_granted': 'Rôle admin attribué (CLI)',
  'admin.role_revoked': 'Rôle admin retiré (CLI)',
  'admin.2fa_reset': 'Double authentification réinitialisée (CLI)',
  'admin.2fa_enrolled': 'Double authentification activée',
  'admin.2fa_verified': 'Code admin validé',
  'admin.2fa_failed': 'Code admin refusé',
  'admin.recovery_code_used': 'Code de secours utilisé',
  'admin.recovery_codes_regenerated': 'Codes de secours régénérés',
  'admin.session_ended': 'Sortie de l’espace admin',
  'admin.user_searched': 'Recherche par e-mail',
  'admin.user_viewed': 'Fiche utilisateur consultée',
  'admin.trial_extended': 'Essai prolongé',
  'admin.pro_month_granted': 'Mois de Pro offert',
  'admin.user_suspended': 'Compte suspendu',
  'admin.user_reactivated': 'Compte réactivé',
  'admin.verification_resent': 'E-mail de vérification renvoyé',
  'admin.user_deleted': 'Compte supprimé (RGPD)',
};

/** Action quelconque du journal (les actions `auth.*` et `account.*` des phases précédentes y figurent aussi). */
export const auditActionSchema = z.string().regex(/^[a-z0-9_]+\.[a-z0-9_.]+$/).max(64);

/** Valeur d'un instantané avant / après : scalaire JSON borné (dates en ISO). */
export const auditScalarSchema = z.union([externalText(500), z.number(), z.boolean(), z.null()]);
export const auditSnapshotSchema = z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/), auditScalarSchema);
export type AuditSnapshot = z.infer<typeof auditSnapshotSchema>;

export const auditMetadataSchema = z.object({
  before: auditSnapshotSchema.optional(),
  after: auditSnapshotSchema.optional(),
  /** Motif saisi par l'admin. */
  reason: externalText(500).optional(),
  /** Compléments sans donnée personnelle (ex. `resultCount` d'une recherche, `days` d'une prolongation). */
  details: auditSnapshotSchema.optional(),
});
export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

export const auditActorKindSchema = z.enum(['admin', 'user', 'cli', 'system']);
export type AuditActorKind = z.infer<typeof auditActorKindSchema>;

export const auditLogEntrySchema = z.object({
  id: z.uuid(),
  action: auditActionSchema,
  actorKind: auditActorKindSchema,
  /** Auteur (admin ou utilisateur) ; `null` pour la CLI, le système ou un compte supprimé. */
  actor: z.object({ id: z.uuid(), email: z.email() }).nullable(),
  /** Compte visé ; `null` après suppression du compte (journal conservé). */
  targetUserId: z.uuid().nullable(),
  metadata: auditMetadataSchema,
  createdAt: z.iso.datetime(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const adminAuditLogQuerySchema = z.object({
  userId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  action: auditActionSchema.optional(),
  ...pageQueryShape,
});
export type AdminAuditLogQuery = z.infer<typeof adminAuditLogQuerySchema>;

export const adminAuditLogPageSchema = pageResponseSchema(auditLogEntrySchema);
export type AdminAuditLogPage = z.infer<typeof adminAuditLogPageSchema>;
