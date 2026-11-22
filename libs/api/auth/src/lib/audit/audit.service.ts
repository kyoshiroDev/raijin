import { Inject, Injectable, Logger } from '@nestjs/common';
import { afterCursor, APP_CONFIG, encodePageCursor, errorCode, hmac, type AppConfig } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import {
  auditActorKindSchema,
  auditMetadataSchema,
  type AdminAuditLogPage,
  type AdminAuditLogQuery,
  type AuditActorKind,
  type AuditLogEntry,
  type AuditMetadata,
} from '@raijin/shared-contracts';
import type { ClientInfo } from '../services/client-info';

/** Entrée structurée du journal (actions admin, CLI, jobs) : écrite dans la transaction de la modification. */
export interface AuditEntry {
  /** Ex. `admin.user_suspended` (`ADMIN_AUDIT_ACTIONS`) ou toute action `domaine.verbe`. */
  readonly action: string;
  readonly actorKind: AuditActorKind;
  /** Auteur (compte admin) ; `null` pour la CLI et le système. */
  readonly actorId: string | null;
  /** Compte visé ; `null` si aucun. */
  readonly userId: string | null;
  /** Avant / après (champs modifiés seulement), motif, détails : validé par `auditMetadataSchema`. */
  readonly metadata?: AuditMetadata;
  /** IP (hachée avant stockage) et user-agent de la requête, si elle existe. */
  readonly client?: ClientInfo | null;
}

/** Client Prisma transactionnel ou non (les deux exposent `auditLog`). */
export type AuditWriter = Pick<Prisma.TransactionClient, 'auditLog'>;

const ACTION_PATTERN = /^[a-z0-9_]+\.[a-z0-9_.]+$/;

const entrySelect = {
  id: true,
  action: true,
  actorKind: true,
  actorId: true,
  userId: true,
  metadata: true,
  createdAt: true,
} satisfies Prisma.AuditLogSelect;
type EntryRow = Prisma.AuditLogGetPayload<{ select: typeof entrySelect }>;

/**
 * Journal d'audit (table `AuditLog`, docs/ARCHITECTURE.md §14.8). Jamais d'e-mail, d'IP en clair, de mot de passe,
 * de jeton, de secret, de code TOTP ni de hash dans `metadata`.
 * - `record(...)` : événements de sécurité des parcours utilisateur (connexion, mots de passe…), **sans jamais
 *   casser** le parcours (échec journalisé) ;
 * - `recordInTx(tx, entry)` : actions admin / CLI, **dans la transaction** de la modification : un échec d'écriture
 *   annule la modification (pas d'action sans trace) ;
 * - `list(query)` / `forUser(userId)` : lecture pour l'espace admin (contrat `AuditLogEntry`).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** IP hachée (HMAC avec COOKIE_SECRET) : jamais stockée en clair. */
  hashIp(ip: string | null): string | null {
    return ip ? hmac(this.config.auth.cookieSecret, `ip:${ip}`) : null;
  }

  /** HMAC d'une valeur personnelle (texte cherché…) : corrélable, jamais réversible ni stockée en clair. */
  fingerprint(value: string): string {
    return hmac(this.config.auth.cookieSecret, `audit:${value}`).slice(0, 22);
  }

  async record(
    action: string,
    userId: string | null,
    client: ClientInfo | null,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          userId,
          ipHash: this.hashIp(client?.ip ?? null),
          userAgent: client?.userAgent ?? null,
          ...(metadata === undefined ? {} : { metadata }),
        },
      });
    } catch (error) {
      // L'audit ne doit jamais casser le parcours utilisateur.
      this.logger.error(`Audit « ${action} » non enregistré (${errorCode(error)})`);
    }
  }

  /**
   * Écrit une entrée avec le client donné (transaction en cours, ou `PrismaService` hors transaction).
   * Lève si l'entrée est invalide ou si l'écriture échoue : la transaction appelante est annulée.
   */
  async recordInTx(tx: AuditWriter, entry: AuditEntry): Promise<{ id: string }> {
    if (!ACTION_PATTERN.test(entry.action) || entry.action.length > 64) throw new Error('AUDIT_ACTION_INVALID');
    auditActorKindSchema.parse(entry.actorKind);
    const metadata = entry.metadata === undefined ? undefined : auditMetadataSchema.parse(entry.metadata);
    return tx.auditLog.create({
      data: {
        action: entry.action,
        actorKind: entry.actorKind,
        actorId: entry.actorId,
        userId: entry.userId,
        ipHash: this.hashIp(entry.client?.ip ?? null),
        userAgent: entry.client?.userAgent ?? null,
        ...(metadata === undefined ? {} : { metadata: metadata as Prisma.InputJsonValue }),
      },
      select: { id: true },
    });
  }

  /** Même chose dans sa propre écriture (aucune autre modification à lier). */
  recordStrict(entry: AuditEntry): Promise<{ id: string }> {
    return this.recordInTx(this.prisma, entry);
  }

  /** `GET admin/audit-logs` : journal paginé, du plus récent au plus ancien. */
  async list(query: AdminAuditLogQuery): Promise<AdminAuditLogPage> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(afterCursor(query.cursor) as Prisma.AuditLogWhereInput | undefined),
    };
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: entrySelect,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: await this.toEntries(page),
      nextCursor: rows.length > query.limit && last ? encodePageCursor(last) : null,
    };
  }

  /** Dernières entrées visant un compte (fiche utilisateur). */
  async forUser(userId: string, limit: number): Promise<AuditLogEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: entrySelect,
    });
    return this.toEntries(rows);
  }

  /** Convertit des lignes en entrées du contrat (auteur résolu en une requête ; métadonnées hors schéma réduites). */
  async toEntries(rows: readonly EntryRow[]): Promise<AuditLogEntry[]> {
    const actorIds = [...new Set(rows.map((row) => row.actorId).filter((id): id is string => id !== null))];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
      : [];
    const emails = new Map(actors.map((actor) => [actor.id, actor.email]));
    return rows.map((row) => {
      const kind = auditActorKindSchema.safeParse(row.actorKind);
      const metadata = auditMetadataSchema.safeParse(row.metadata ?? {});
      const email = row.actorId ? emails.get(row.actorId) : undefined;
      return {
        id: row.id,
        action: ACTION_PATTERN.test(row.action) && row.action.length <= 64 ? row.action : 'audit.unknown',
        actorKind: kind.success ? kind.data : 'user',
        actor: row.actorId && email ? { id: row.actorId, email } : null,
        targetUserId: row.userId,
        // Anciennes entrées (`auth.*`) : métadonnées libres non exposées telles quelles.
        metadata: metadata.success ? metadata.data : {},
        createdAt: row.createdAt.toISOString(),
      };
    });
  }
}
