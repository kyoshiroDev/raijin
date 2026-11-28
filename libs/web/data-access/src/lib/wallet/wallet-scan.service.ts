import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { QuotaInfo, WalletScanResult } from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { loadContracts } from '../contracts';
import { toClientError, type ClientError } from '../http/api-error';

/**
 * Accès au scan, d'après `GET wallet-scans/quota` :
 * - `unknown` : pas encore demandé ; `checking` : en cours ;
 * - `allowed` : Pro ou essai Pro (quota du jour dans `quota()`) ;
 * - `plan_required` : plan Gratuit (y compris e-mail non confirmé) ;
 * - `signed_out` : session absente ou expirée (401) ;
 * - `error` : l'API n'a pas répondu (`accessError()`).
 */
export type WalletScanAccess = 'unknown' | 'checking' | 'allowed' | 'plan_required' | 'signed_out' | 'error';

/** `idle` : aucun scan ; `loading` : scan en cours ; `ready` : résultat ; `error` : `error()` porte le code. */
export type WalletScanStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Scan de wallet en lecture seule (`/api/v1/wallet-scans`, docs/ARCHITECTURE.md §12).
 *
 * RGPD (§12.8) : l'adresse n'existe qu'en mémoire, dans ce service, fourni au niveau de l'écran
 * (`providers`) et détruit avec lui. Elle part dans le **corps** du POST, jamais dans l'URL, et
 * n'est jamais écrite dans `localStorage`, `sessionStorage` ni un cookie. Chaque réponse est
 * validée par son schéma Zod (contrats chargés à la demande) : noms et symboles nettoyés.
 */
@Injectable()
export class WalletScanService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private sequence = 0;

  private readonly currentAccess = signal<WalletScanAccess>('unknown');
  private readonly currentAccessError = signal<ClientError | null>(null);
  private readonly currentStatus = signal<WalletScanStatus>('idle');
  private readonly currentResult = signal<WalletScanResult | null>(null);
  private readonly currentError = signal<ClientError | null>(null);
  private readonly currentQuota = signal<QuotaInfo | null>(null);

  readonly access = this.currentAccess.asReadonly();
  readonly accessError = this.currentAccessError.asReadonly();
  readonly status = this.currentStatus.asReadonly();
  readonly result = this.currentResult.asReadonly();
  readonly error = this.currentError.asReadonly();
  readonly quota = this.currentQuota.asReadonly();
  readonly loading = computed(() => this.currentStatus() === 'loading');
  /** Plus aucun scan aujourd'hui (quota connu à 0 ou réponse 429). */
  readonly quotaExhausted = computed(
    () => this.currentError()?.code === 'WALLET_SCAN_QUOTA_EXCEEDED' || this.currentQuota()?.remaining === 0,
  );

  /** `GET wallet-scans/quota` : droit au scan et quota du jour. */
  async checkAccess(): Promise<void> {
    this.currentAccess.set('checking');
    this.currentAccessError.set(null);
    try {
      const [body, contracts] = await Promise.all([firstValueFrom(this.http.get(`${this.base}/wallet-scans/quota`)), loadContracts()]);
      const response = contracts.walletScanQuotaResponseSchema.parse(body);
      this.currentQuota.set(response.quota);
      this.currentAccess.set(response.allowed ? 'allowed' : 'plan_required');
    } catch (error) {
      const clientError = toClientError(error);
      if (clientError.code === 'WALLET_SCAN_PLAN_REQUIRED') {
        this.currentAccess.set('plan_required');
      } else if (clientError.code === 'UNAUTHORIZED') {
        this.currentAccess.set('signed_out');
      } else {
        this.currentAccessError.set(clientError);
        this.currentAccess.set('error');
      }
    }
  }

  /**
   * `POST wallet-scans` avec `{ address }` (adresse déjà validée par l'écran, revalidée ici).
   * Résout `true` si un résultat est arrivé. Une réponse dépassée par un scan plus récent est ignorée.
   */
  async scan(address: string): Promise<boolean> {
    const id = ++this.sequence;
    this.currentError.set(null);
    this.currentResult.set(null);
    this.currentStatus.set('loading');
    try {
      const contracts = await loadContracts();
      const request = contracts.walletScanRequestSchema.safeParse({ address });
      if (!request.success) {
        const code = contracts.knownNonWalletKind(address.trim()) === 'mint' ? 'WALLET_IS_TOKEN' : 'WALLET_INVALID';
        this.fail(id, { code, message: contracts.WALLET_ERROR_MESSAGES[code], status: 0 });
        return false;
      }
      const body = await firstValueFrom(this.http.post(`${this.base}/wallet-scans`, request.data));
      const response = contracts.walletScanResponseSchema.parse(body);
      if (id !== this.sequence) return false;
      this.currentQuota.set(response.quota);
      this.currentAccess.set('allowed');
      this.currentResult.set(response.scan);
      this.currentStatus.set('ready');
      return true;
    } catch (error) {
      const clientError = toClientError(error);
      if (id !== this.sequence) return false;
      if (clientError.code === 'WALLET_SCAN_PLAN_REQUIRED') this.currentAccess.set('plan_required');
      if (clientError.code === 'UNAUTHORIZED') this.currentAccess.set('signed_out');
      if (clientError.code === 'WALLET_SCAN_QUOTA_EXCEEDED') {
        const quota = this.currentQuota();
        if (quota) this.currentQuota.set({ ...quota, used: quota.limit ?? quota.used, remaining: 0 });
      }
      this.fail(id, clientError);
      return false;
    }
  }

  /** Efface le résultat et l'adresse scannée (nouvelle saisie, sortie de l'écran). */
  reset(): void {
    this.sequence++;
    this.currentResult.set(null);
    this.currentError.set(null);
    this.currentStatus.set('idle');
  }

  private fail(id: number, error: ClientError): void {
    if (id !== this.sequence) return;
    this.currentResult.set(null);
    this.currentError.set(error);
    this.currentStatus.set('error');
  }
}
