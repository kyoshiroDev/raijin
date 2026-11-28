import { DOCUMENT } from '@angular/common';
import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import type { PublicUser } from '@raijin/shared-contracts';
import { AuthStore } from '../auth/auth.store';
import { runWhenIdle } from '../util/idle';

const DAY_MS = 86_400_000;

/** Clé `localStorage` : date (AAAA-MM-JJ, heure locale) de la dernière fermeture. Aucune donnée personnelle. */
export const TRIAL_BANNER_STORAGE_KEY = 'rj.trial-banner.closed';

/**
 * Jours restants, arrondis au jour supérieur. Même calcul que `trialDaysRemaining` des contrats (vérifié par
 * un test), recopié ici pour que la coque (bundle initial) n'importe aucune valeur des contrats (Zod).
 */
export function bannerDaysRemaining(endsAt: string, now: number): number {
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.ceil((end - now) / DAY_MS));
}

/** Date locale du jour au format AAAA-MM-JJ. */
export function localDay(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Texte du bandeau : factuel, sans urgence ni compte à rebours. */
export function trialBannerText(days: number): string {
  if (days <= 1) return 'Essai Pro : se termine aujourd’hui';
  return `Essai Pro : il reste ${days} jours`;
}

export interface TrialBanner {
  readonly text: string;
  readonly linkLabel: string;
  readonly linkPath: string;
}

/** Bandeau à afficher pour cet utilisateur, ou `null` (essai inactif ou échu). */
export function trialBannerFor(user: PublicUser | null, now: number): TrialBanner | null {
  if (!user || user.trial.status !== 'active' || !user.trial.endsAt) return null;
  if (Date.parse(user.trial.endsAt) <= now) return null;
  const days = bannerDaysRemaining(user.trial.endsAt, now);
  // Dernières 24 h : le récapitulatif de l'essai (écran de fin) est disponible.
  return days <= 1
    ? { text: trialBannerText(days), linkLabel: 'Voir mon récapitulatif', linkPath: '/abonnement/fin-essai' }
    : { text: trialBannerText(days), linkLabel: 'Voir les offres', linkPath: '/abonnement' };
}

/** Bandeau après la fin de l'essai, tant que l'écran de fin n'a pas été vu (`endScreenDue`). */
export const TRIAL_ENDED_BANNER: TrialBanner = {
  text: 'Ton essai Pro est terminé',
  linkLabel: 'Voir mon récapitulatif',
  linkPath: '/abonnement/fin-essai',
};

/** Essai terminé sans abonnement : seul cas où l'écran de fin peut être dû après l'essai. */
export function mayHaveEndScreenDue(user: PublicUser | null): boolean {
  return !!user && user.trial.status === 'ended' && user.plan === 'FREE';
}

/**
 * État du bandeau d'essai de la coque : visible pendant tout l'essai actif, refermable une fois par jour
 * (date mémorisée en `localStorage`, réaffiché le lendemain). Pendant l'essai, aucune requête : tout vient
 * de la session. Essai terminé sans abonnement : une lecture de `billing/subscription` (navigateur inactif,
 * contrats chargés à la demande) dit si l'écran de fin reste à voir.
 */
@Injectable({ providedIn: 'root' })
export class TrialBannerState {
  private readonly auth = inject(AuthStore);
  private readonly injector = inject(Injector);
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly storage = this.readStorage();
  private readonly closedOn = signal<string | null>(this.read());
  private readonly now = signal(Date.now());
  private readonly endScreenDue = signal(false);
  private checkedFor: string | null = null;

  readonly banner = computed(() => {
    const now = this.now();
    if (this.closedOn() === localDay(now)) return null;
    const user = this.auth.user();
    if (this.endScreenDue() && mayHaveEndScreenDue(user)) return TRIAL_ENDED_BANNER;
    return trialBannerFor(user, now);
  });

  constructor() {
    effect(() => {
      const user = this.auth.user();
      if (!mayHaveEndScreenDue(user) || !user || this.checkedFor === user.id) return;
      this.checkedFor = user.id;
      untracked(() => runWhenIdle(() => void this.checkEndScreen(), this.view));
    });
  }

  /** L'écran de fin a été vu (« Continuer en Gratuit ») : le bandeau de fin disparaît. */
  endScreenSeen(): void {
    this.endScreenDue.set(false);
  }

  private async checkEndScreen(): Promise<void> {
    try {
      // Client chargé à la demande : rien de l'abonnement dans le bundle initial.
      const { BillingApi } = await import('./billing-api');
      this.endScreenDue.set((await this.injector.get(BillingApi).account()).trial.endScreenDue);
    } catch {
      // Sans réponse, pas de bandeau : l'écran reste accessible depuis Abonnement et Suivis.
    }
  }

  /** Recalcule « maintenant » (changement de route) : le texte suit les jours sans minuterie. */
  tick(now = Date.now()): void {
    this.now.set(now);
  }

  dismiss(now = Date.now()): void {
    const day = localDay(now);
    this.closedOn.set(day);
    try {
      this.storage?.setItem(TRIAL_BANNER_STORAGE_KEY, day);
    } catch {
      // Stockage indisponible (navigation privée) : fermé pour cette session seulement.
    }
  }

  private read(): string | null {
    try {
      return this.storage?.getItem(TRIAL_BANNER_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private readStorage(): Storage | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }
}
