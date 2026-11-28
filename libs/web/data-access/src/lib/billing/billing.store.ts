import { Injectable, computed, inject, signal } from '@angular/core';
import type { BillingAccount, BillingPlansResponse } from '@raijin/shared-contracts';
import { toClientError, type ClientError } from '../http/api-error';
import { BillingApi } from './billing-api';

export type BillingStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Store de l'abonnement (signals) : offres publiques (`billing/plans`) et compte de facturation
 * (`billing/subscription`, connecté seulement). Le front affiche ce que l'API renvoie : droits, prix
 * et état de l'essai ne sont jamais calculés ici. Chargé à la demande (aucune requête au démarrage).
 */
@Injectable({ providedIn: 'root' })
export class BillingStore {
  private readonly api = inject(BillingApi);

  private readonly currentPlans = signal<BillingPlansResponse | null>(null);
  private readonly currentAccount = signal<BillingAccount | null>(null);
  private readonly currentStatus = signal<BillingStatus>('idle');
  private readonly currentError = signal<ClientError | null>(null);

  readonly plans = this.currentPlans.asReadonly();
  readonly account = this.currentAccount.asReadonly();
  readonly status = this.currentStatus.asReadonly();
  readonly error = this.currentError.asReadonly();
  /** Mode de facturation : celui du compte s'il est connu, sinon celui des offres. */
  readonly mode = computed(() => this.currentAccount()?.mode ?? this.currentPlans()?.mode ?? null);

  /** Charge les offres, et le compte si l'utilisateur est connecté. */
  async load(authenticated: boolean): Promise<void> {
    if (this.currentStatus() !== 'ready') this.currentStatus.set('loading');
    try {
      const [plans, account] = await Promise.all([this.api.plans(), authenticated ? this.api.account() : Promise.resolve(null)]);
      this.currentPlans.set(plans);
      this.currentAccount.set(account);
      this.currentError.set(null);
      this.currentStatus.set('ready');
    } catch (error) {
      this.currentError.set(toClientError(error));
      if (this.currentStatus() !== 'ready') this.currentStatus.set('error');
    }
  }

  /** Relit le compte (après une action du portail ou un retour de Checkout). */
  async refreshAccount(): Promise<BillingAccount> {
    const account = await this.api.account();
    this.currentAccount.set(account);
    return account;
  }

  /** Oublie le compte (déconnexion). */
  reset(): void {
    this.currentAccount.set(null);
    this.currentStatus.set(this.currentPlans() ? 'ready' : 'idle');
  }
}
