import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import type {
  BillingAccount,
  BillingInterval,
  BillingPlansResponse,
  FakeCheckoutCompleteRequest,
  FakePortalActionRequest,
} from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { loadContracts } from '../contracts';

/** Accès à `window.location` (remplacé dans les tests) : origine de l'app et redirection pleine page. */
export interface BillingLocation {
  readonly origin: string;
  assign(url: string): void;
}

export const BILLING_LOCATION = new InjectionToken<BillingLocation>('BILLING_LOCATION', {
  providedIn: 'root',
  factory: () => {
    const location = inject(DOCUMENT).defaultView?.location;
    return {
      origin: location?.origin ?? '',
      assign: (url: string) => location?.assign(url),
    };
  },
});

/** Erreur levée quand l'URL renvoyée par l'API n'est ni Stripe ni l'origine de l'app (redirection ouverte). */
export class BillingRedirectRefusedError extends Error {
  constructor() {
    super('Redirection de paiement refusée.');
    this.name = 'BillingRedirectRefusedError';
  }
}

/**
 * Client HTTP de l'abonnement (`/api/v1/billing`, docs/ARCHITECTURE.md §13.2). Le front n'envoie que la
 * périodicité : prix, client et URLs de retour sont décidés par l'API. Une URL de redirection n'est suivie
 * que si `isAllowedBillingRedirect` l'accepte (hôtes Stripe exacts en https, ou même origine en simulation).
 */
@Injectable({ providedIn: 'root' })
export class BillingApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly location = inject(BILLING_LOCATION);

  async plans(): Promise<BillingPlansResponse> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.get(`${this.base}/billing/plans`)), loadContracts()]);
    return contracts.billingPlansResponseSchema.parse(body);
  }

  async account(): Promise<BillingAccount> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.get(`${this.base}/billing/subscription`)), loadContracts()]);
    return contracts.billingAccountSchema.parse(body);
  }

  /** Crée une session Checkout puis quitte l'app vers l'URL renvoyée (si elle est autorisée). */
  async startCheckout(interval: BillingInterval): Promise<void> {
    const contracts = await loadContracts();
    const request = contracts.checkoutSessionRequestSchema.parse({ interval });
    const body = await firstValueFrom(this.http.post(`${this.base}/billing/checkout-sessions`, request));
    this.redirect(contracts.billingRedirectSchema.parse(body).url, contracts.isAllowedBillingRedirect);
  }

  /** Ouvre le portail client (Stripe ou faux portail en simulation). */
  async openPortal(): Promise<void> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.post(`${this.base}/billing/portal-sessions`, {})), loadContracts()]);
    this.redirect(contracts.billingRedirectSchema.parse(body).url, contracts.isAllowedBillingRedirect);
  }

  /** Faux Checkout (`mode: simulation` uniquement ; 404 sinon). */
  async simulateCheckout(request: FakeCheckoutCompleteRequest): Promise<void> {
    const contracts = await loadContracts();
    const body = contracts.fakeCheckoutCompleteRequestSchema.parse(request);
    await firstValueFrom(this.http.post(`${this.base}/billing/simulation/checkout`, body));
  }

  /** Faux portail (`mode: simulation` uniquement ; 404 sinon). */
  async simulatePortal(request: FakePortalActionRequest): Promise<void> {
    const contracts = await loadContracts();
    const body = contracts.fakePortalActionRequestSchema.parse(request);
    await firstValueFrom(this.http.post(`${this.base}/billing/simulation/portal`, body));
  }

  private redirect(url: string, isAllowed: (url: string, origin: string) => boolean): void {
    if (!isAllowed(url, this.location.origin)) throw new BillingRedirectRefusedError();
    this.location.assign(url);
  }
}
