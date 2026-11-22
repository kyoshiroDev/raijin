import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import type { AdminRecoveryCodes, AdminSecurityStatus } from '@raijin/shared-contracts';
import { AuthStore } from '../../auth/auth.store';
import { rawErrorCode } from '../../http/error-code';
import { AdminSecurityApi } from './admin-security-api';
import {
  ADMIN_EXPIRED_REASON,
  ADMIN_NOT_FOUND_URL,
  ADMIN_PATHS,
  isAdminSecurityPath,
  safeAdminReturn,
} from './admin-paths';

/** `idle` : rien demandé ; `not_found` : l'API répond 404 (compte non admin, espace invisible). */
export type AdminSessionState = 'idle' | 'loading' | 'ready' | 'error' | 'not_found';

/** Motif de verrouillage : 2FA à activer, code à saisir, session expirée (inactivité ou durée maximale). */
export type AdminLockReason = 'enrollment' | 'required' | 'expired';

/** Codes 403 de session admin (jamais 401 : l'intercepteur de refresh de l'app ne s'en mêle pas). */
const LOCK_CODES: Readonly<Record<string, AdminLockReason>> = {
  ADMIN_2FA_ENROLLMENT_REQUIRED: 'enrollment',
  ADMIN_2FA_REQUIRED: 'required',
  ADMIN_SESSION_EXPIRED: 'expired',
};

/** Seuil sous lequel l'écran signale qu'il reste peu de codes de secours. */
export const ADMIN_RECOVERY_CODES_LOW = 3;

/**
 * État de la session admin côté front (docs/ARCHITECTURE.md §14.3) : statut 2FA, minuteur d'inactivité
 * aligné sur `idleTimeoutSeconds` (et plafonné par la fin absolue), verrouillage sur les 403 `ADMIN_*`.
 *
 * Au verrouillage, les données des écrans sont effacées : chaque store admin s'abonne par `onReset()` (ou lit
 * `epoch()`) et vide ses signaux. Le vrai contrôle reste côté serveur (`AdminGuard`).
 */
@Injectable({ providedIn: 'root' })
export class AdminSessionStore {
  private readonly api = inject(AdminSecurityApi);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthStore);
  private readonly view = inject(DOCUMENT).defaultView;

  private readonly currentState = signal<AdminSessionState>('idle');
  private readonly currentStatus = signal<AdminSecurityStatus | null>(null);
  private readonly currentLock = signal<AdminLockReason | null>(null);
  private readonly deadline = signal<number | null>(null);
  private readonly resetCount = signal(0);
  private readonly resetHandlers = new Set<() => void>();
  private loading: Promise<AdminSessionState> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingCodes: AdminRecoveryCodes | null = null;
  private userId: string | null = null;

  readonly state = this.currentState.asReadonly();
  readonly status = this.currentStatus.asReadonly();
  /** Dernier motif de verrouillage (affiché par l'écran de saisie du code). */
  readonly lockReason = this.currentLock.asReadonly();
  /** Fin de la session admin si aucune activité (ms depuis l'epoch), `null` hors session vérifiée. */
  readonly expiresAt = this.deadline.asReadonly();
  /** Incrémenté à chaque effacement des données admin : les stores des écrans s'y abonnent. */
  readonly epoch = this.resetCount.asReadonly();
  readonly enrolled = computed(() => this.currentStatus()?.enrolled === true);
  readonly verified = computed(() => this.currentState() === 'ready' && this.currentStatus()?.verified === true);
  readonly recoveryCodesRemaining = computed(() => this.currentStatus()?.recoveryCodesRemaining ?? null);
  readonly recoveryCodesLow = computed(() => {
    const remaining = this.recoveryCodesRemaining();
    return remaining !== null && remaining < ADMIN_RECOVERY_CODES_LOW;
  });

  constructor() {
    // Déconnexion ou changement de compte : plus rien de l'espace admin ne reste en mémoire.
    effect(() => {
      const id = this.auth.user()?.id ?? null;
      untracked(() => {
        if (this.userId !== null && id !== this.userId) this.clear();
        this.userId = id;
      });
    });
    this.view?.document.addEventListener('visibilitychange', () => this.checkDeadline());
  }

  /**
   * Statut de la session admin (`GET admin/security/status`), mis en cache tant qu'il est connu.
   * `force` relit le serveur. Un 404 passe l'état à `not_found` (l'appelant affiche la page 404).
   */
  ensureStatus(force = false): Promise<AdminSessionState> {
    const state = this.currentState();
    if (!force && state === 'ready' && this.currentStatus()) return Promise.resolve(state);
    this.loading ??= this.fetchStatus().finally(() => (this.loading = null));
    return this.loading;
  }

  private async fetchStatus(): Promise<AdminSessionState> {
    // Relecture d'un statut déjà connu : l'écran reste affiché pendant la requête.
    if (this.currentState() !== 'ready') this.currentState.set('loading');
    try {
      this.applyStatus(await this.api.status());
    } catch (error) {
      this.currentState.set(error instanceof HttpErrorResponse && error.status === 404 ? 'not_found' : 'error');
    }
    return this.currentState();
  }

  /** Nouveau statut reçu de l'API (statut, vérification, confirmation d'enrôlement). */
  applyStatus(status: AdminSecurityStatus): void {
    this.currentStatus.set(status);
    this.currentState.set('ready');
    if (status.verified) {
      this.currentLock.set(null);
      const idle = status.idleExpiresAt ? Date.parse(status.idleExpiresAt) : Date.now() + status.idleTimeoutSeconds * 1000;
      this.arm(idle);
    } else {
      this.disarm();
    }
  }

  /** Réponse réussie d'une route admin : le serveur a prolongé la session, le minuteur aussi. */
  touch(): void {
    const status = this.currentStatus();
    if (!status?.verified) return;
    this.arm(Date.now() + status.idleTimeoutSeconds * 1000);
  }

  /**
   * Erreur d'une route `admin/*` (appelé par l'intercepteur). Les 403 de session admin verrouillent l'espace :
   * données effacées, puis écran d'activation ou de saisie du code avec retour à la page courante.
   * Renvoie `true` si l'erreur a été prise en charge.
   */
  handleError(error: unknown): boolean {
    if (!(error instanceof HttpErrorResponse) || error.status !== 403) return false;
    const reason = LOCK_CODES[rawErrorCode(error) ?? ''];
    if (!reason) return false;
    this.lock(reason);
    return true;
  }

  /** Verrouille l'espace admin (403 serveur ou minuteur d'inactivité côté front). */
  lock(reason: AdminLockReason): void {
    const status = this.currentStatus();
    if (status) {
      this.currentStatus.set({
        ...status,
        enrolled: reason === 'enrollment' ? false : status.enrolled,
        verified: false,
        idleExpiresAt: null,
        absoluteExpiresAt: null,
      });
      this.currentState.set('ready');
    }
    this.currentLock.set(reason);
    this.disarm();
    this.resetData();
    const current = this.router.url;
    if (isAdminSecurityPath(current)) return;
    if (reason === 'enrollment') {
      void this.router.navigateByUrl(ADMIN_PATHS.enrollment);
      return;
    }
    void this.router.navigate([ADMIN_PATHS.verify], {
      queryParams: { retour: safeAdminReturn(current), motif: reason === 'expired' ? ADMIN_EXPIRED_REASON : null },
    });
  }

  /** Affiche la page 404 standard sans changer l'URL (compte non admin ou rôle retiré). */
  showNotFound(): void {
    this.clear();
    this.currentState.set('not_found');
    void this.router.navigateByUrl(ADMIN_NOT_FOUND_URL, { skipLocationChange: true });
  }

  /** S'abonne à l'effacement des données admin ; renvoie la fonction de désabonnement. */
  onReset(handler: () => void): () => void {
    this.resetHandlers.add(handler);
    return () => this.resetHandlers.delete(handler);
  }

  /** Codes de secours à montrer une seule fois (après l'enrôlement), gardés en mémoire seulement. */
  setPendingRecoveryCodes(codes: AdminRecoveryCodes): void {
    this.pendingCodes = codes;
  }

  /** Rend les codes en attente et les oublie : un rechargement de page ne les remontre jamais. */
  takePendingRecoveryCodes(): AdminRecoveryCodes | null {
    const codes = this.pendingCodes;
    this.pendingCodes = null;
    return codes;
  }

  /** « Quitter l'admin » : fin de la session admin côté serveur (la session de l'app reste), puis Compte. */
  async end(): Promise<void> {
    try {
      await this.api.end();
    } finally {
      this.clear();
      await this.router.navigateByUrl('/compte');
    }
  }

  /** Oublie tout (déconnexion, changement de compte, sortie de l'admin). */
  clear(): void {
    this.disarm();
    this.pendingCodes = null;
    this.currentStatus.set(null);
    this.currentLock.set(null);
    this.currentState.set('idle');
    this.resetData();
  }

  private resetData(): void {
    this.resetCount.update((count) => count + 1);
    for (const handler of [...this.resetHandlers]) handler();
  }

  private arm(idleDeadline: number): void {
    const absolute = this.currentStatus()?.absoluteExpiresAt;
    const end = absolute ? Math.min(idleDeadline, Date.parse(absolute)) : idleDeadline;
    this.deadline.set(end);
    if (this.timer !== null) clearTimeout(this.timer);
    // Les navigateurs bornent setTimeout à ~24,8 jours : la session admin dure 8 h au plus.
    this.timer = setTimeout(() => this.checkDeadline(), Math.max(0, end - Date.now()));
  }

  private disarm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.deadline.set(null);
  }

  /** Échéance passée (minuteur, ou retour sur l'onglet après une mise en veille) : session expirée. */
  private checkDeadline(): void {
    const end = this.deadline();
    if (end === null || !this.currentStatus()?.verified) return;
    if (Date.now() >= end) {
      this.lock('expired');
    } else if (this.timer === null) {
      this.arm(end);
    }
  }
}
