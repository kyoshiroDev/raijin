import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, hmac, ipBucket, type AppConfig } from '@raijin/api-core';
import type { Prisma } from '@raijin/api-prisma';
import type { TrialRefusalReason } from '@raijin/shared-contracts';
import type { ClientInfo } from '../services/client-info';
import { isDisposableEmail } from './disposable-domains';

const DAY_MS = 86_400_000;

/** Utilisateur dont l'e-mail vient d'être vérifié (colonnes utiles à l'essai). */
export interface TrialCandidate {
  readonly id: string;
  readonly email: string;
  readonly emailNormalized: string;
  readonly plan: 'FREE' | 'PRO';
  readonly trialStatus: string;
}

export type TrialOutcome =
  | { readonly kind: 'started'; readonly startedAt: Date; readonly endsAt: Date }
  | { readonly kind: 'refused'; readonly reason: TrialRefusalReason }
  /** Essai déjà décidé (ou compte déjà Pro) : rien ne change. */
  | { readonly kind: 'skipped' };

/**
 * Anti-abus de l'essai Pro (docs/ARCHITECTURE.md §13.6), appliqué **une seule fois**, dans la
 * transaction qui pose `emailVerifiedAt`. Contrôles dans l'ordre (le premier qui échoue donne
 * `INELIGIBLE` et un `ProductEvent trial_refused {reason}`, jamais un message spécifique) :
 * 1. e-mail normalisé déjà utilisé pour un essai (`TrialClaim`, HMAC, survit à la suppression du compte) ;
 * 2. domaine ou domaine parent jetable (liste CC0 copiée dans le dépôt + ajouts maison) ;
 * 3. empreinte HMAC(IP /64 + user-agent) de la requête de vérification déjà accordée dans la fenêtre de rétention.
 * Accord : `TrialClaim` + `TrialFingerprint` écrits sous verrous consultatifs (e-mail et empreinte) :
 * deux vérifications simultanées ne donnent jamais deux essais.
 */
@Injectable()
export class TrialEligibilityService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** HMAC-SHA256(IP_HASH_SECRET, "trial-email:" + e-mail normalisé) : jamais l'adresse en clair. */
  emailHash(emailNormalized: string): string {
    return hmac(this.config.analysis.ipHashSecret, `trial-email:${emailNormalized}`);
  }

  /** HMAC-SHA256(IP_HASH_SECRET, "trial-fp:" + IP (IPv6 /64) + "\n" + user-agent). */
  fingerprint(client: ClientInfo): string {
    return hmac(this.config.analysis.ipHashSecret, `trial-fp:${ipBucket(client.ip)}\n${client.userAgent ?? ''}`);
  }

  /** Motif de refus, ou `null` si l'essai peut démarrer (lecture seule, dans la transaction). */
  async refusalReason(tx: Prisma.TransactionClient, candidate: TrialCandidate, emailHash: string, fingerprint: string, now: Date): Promise<TrialRefusalReason | null> {
    if (await tx.trialClaim.findUnique({ where: { emailHash }, select: { id: true } })) return 'email_already_used';
    if (isDisposableEmail(candidate.email) || isDisposableEmail(candidate.emailNormalized)) return 'disposable_domain';
    const since = new Date(now.getTime() - this.config.trial.fingerprintRetentionDays * DAY_MS);
    if (await tx.trialFingerprint.findFirst({ where: { hash: fingerprint, createdAt: { gte: since } }, select: { id: true } })) return 'fingerprint_seen';
    return null;
  }

  /**
   * Décide et écrit l'essai d'un compte qui vient de vérifier son e-mail (à appeler dans la transaction
   * de `markEmailVerified`). Écrit `User.trialStatus`, les traces anti-abus et l'événement produit.
   */
  async startOnVerification(tx: Prisma.TransactionClient, candidate: TrialCandidate, client: ClientInfo, now: Date): Promise<TrialOutcome> {
    if (candidate.trialStatus !== 'NONE' || candidate.plan === 'PRO') return { kind: 'skipped' };
    const emailHash = this.emailHash(candidate.emailNormalized);
    const fingerprint = this.fingerprint(client);
    // Verrous consultatifs de transaction (ordre fixe : e-mail puis empreinte, pas d'interblocage).
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`trial-email:${emailHash}`}))`;
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`trial-fp:${fingerprint}`}))`;

    const reason = await this.refusalReason(tx, candidate, emailHash, fingerprint, now);
    if (reason) {
      await tx.user.update({ where: { id: candidate.id }, data: { trialStatus: 'INELIGIBLE' } });
      await tx.productEvent.create({ data: { userId: candidate.id, type: 'trial_refused', properties: { reason } } });
      return { kind: 'refused', reason };
    }
    const endsAt = new Date(now.getTime() + this.config.trial.days * DAY_MS);
    await tx.trialClaim.create({ data: { emailHash, userId: candidate.id } });
    await tx.trialFingerprint.create({ data: { hash: fingerprint, userId: candidate.id } });
    await tx.user.update({ where: { id: candidate.id }, data: { trialStatus: 'ACTIVE', trialStartedAt: now, trialEndsAt: endsAt } });
    await tx.productEvent.create({ data: { userId: candidate.id, type: 'trial_started', properties: {} } });
    return { kind: 'started', startedAt: now, endsAt };
  }
}
