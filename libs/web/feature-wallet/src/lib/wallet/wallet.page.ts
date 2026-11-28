import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  ANALYSIS_DISCLAIMER,
  SAFE_VERDICT_REMINDER,
  WALLET_ERROR_MESSAGES,
  WALLET_SCAN_READ_ONLY_NOTICE,
  knownNonWalletKind,
  walletScanRequestSchema,
  type QuotaInfo,
} from '@raijin/shared-contracts';
import { truncateMiddle } from '@raijin/shared-util';
import { AuthStore, WalletScanService } from '@raijin/web-data-access';
import { RjButton, RjCard, RjEmptyState, RjErrorState, RjIcon, RjInputField, RjSkeleton } from '@raijin/web-ui';
import { plural } from './format';
import { RjWalletDelegations } from './wallet-delegations';
import { RjWalletSummary } from './wallet-summary';
import { RjWalletTokenCard } from './wallet-token-card';

/** Ce que fait le scan (écran d'attente, visiteur, plan Gratuit). */
const SCAN_FEATURES = [
  { icon: 'analyse', text: 'Un verdict pour chaque token détenu : contrôle rapide, ou analyse complète si elle est récente.' },
  { icon: 'warn', text: 'Les délégations actives : les adresses autorisées à déplacer tes tokens, et comment les révoquer.' },
  { icon: 'pause', text: 'Les comptes gelés par l’émetteur d’un token, la poussière et les NFT ignorés.' },
] as const;

/** État de la saisie, calculé à chaque frappe (aucun appel réseau). */
type InputState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'seed' }
  | { readonly kind: 'program' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'mint'; readonly address: string }
  | { readonly kind: 'valid'; readonly address: string };

/** Phrase de récupération collée ou tapée par erreur (12 mots ou plus). */
export function looksLikeSeedPhrase(raw: string): boolean {
  return raw.trim().split(/\s+/).length >= 12;
}

/** Analyse la saisie : adresse de wallet, mint ou programme connu, phrase de récupération collée par erreur. */
export function readWalletInput(raw: string): InputState {
  const value = raw.trim();
  if (!value) return { kind: 'empty' };
  if (looksLikeSeedPhrase(value)) return { kind: 'seed' };
  const known = knownNonWalletKind(value);
  if (known === 'mint') return { kind: 'mint', address: value };
  if (known === 'program') return { kind: 'program' };
  const parsed = walletScanRequestSchema.safeParse({ address: value });
  return parsed.success ? { kind: 'valid', address: parsed.data.address } : { kind: 'invalid' };
}

const INPUT_MESSAGES = {
  empty: 'Colle l’adresse publique d’un wallet pour lancer le scan.',
  invalid: 'Adresse invalide : une adresse Solana fait 32 à 44 caractères (sans 0, O, I ni l).',
  program: 'C’est l’adresse d’un programme Solana, pas celle d’un wallet.',
  mint: 'C’est l’adresse d’un token, pas celle d’un wallet.',
  seed: 'On ne te demande jamais ta phrase de récupération. Ne la colle nulle part : Raijin a effacé le champ.',
} as const;

/** Quota du jour, en texte discret. */
export function walletQuotaText(quota: QuotaInfo | null): string {
  if (!quota) return '';
  if (quota.remaining === null || quota.limit === null) return 'Scans illimités avec ton plan.';
  if (quota.remaining === 0) return 'Plus de scan disponible aujourd’hui : le compteur repart à minuit (UTC).';
  return `Il te reste ${plural(quota.remaining, 'scan')} sur ${quota.limit} aujourd’hui.`;
}

type View = 'loading' | 'auth-error' | 'signed-out' | 'plan' | 'access-error' | 'scan';

/**
 * Écran « Scan de wallet » (`/wallet`, PROMPT.md §4.3) : adresse publique collée, **aucune
 * connexion de wallet ni signature**. Résultat : délégations actives en tête, résumé, puis un
 * verdict par token (cartes de même hauteur, 2 colonnes dès 768 px, 3 dès 1280 px).
 * Visiteur et plan Gratuit : explication du scan et essai Pro, sans urgence.
 *
 * RGPD (docs/ARCHITECTURE.md §12.8) : l'adresse reste en mémoire dans cet écran (service fourni
 * ici, détruit à la sortie), jamais dans l'URL, jamais dans le stockage du navigateur.
 */
@Component({
  selector: 'rj-wallet-page',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    RjButton,
    RjCard,
    RjEmptyState,
    RjErrorState,
    RjIcon,
    RjInputField,
    RjSkeleton,
    RjWalletDelegations,
    RjWalletSummary,
    RjWalletTokenCard,
  ],
  providers: [WalletScanService],
  template: `
    <div [class]="'flex flex-col gap-6 md:gap-8 ' + (view() === 'scan' ? 'pb-24 lg:pb-0' : '')">
      <header class="flex flex-col gap-1">
        <h1 class="font-display text-h2 text-ink md:text-h1">Scan de wallet</h1>
        <p class="text-body text-ink-muted">Vérifie les tokens d’une adresse et repère les délégations actives.</p>
      </header>

      <p class="flex items-start gap-3 rounded-lg border border-line-strong bg-surface-raised p-4 text-body text-ink" role="note" data-read-only>
        <rj-icon name="safe" [size]="20" class="mt-0.5 shrink-0 text-safe" />
        <span><strong class="font-semibold">Lecture seule.</strong> {{ readOnlyNotice }}</span>
      </p>

      @switch (view()) {
        @case ('loading') {
          <div class="flex flex-col gap-3" role="status" aria-busy="true" aria-label="Chargement du scan de wallet">
            <rj-skeleton class="h-5 w-48" />
            <div class="flex gap-2"><rj-skeleton shape="block" class="h-12 flex-1" /><rj-skeleton shape="block" class="h-12 w-12 xs:w-28" /></div>
            <rj-skeleton class="h-4 w-64 max-w-full" />
          </div>
        }
        @case ('auth-error') {
          <rj-error-state title="Raijin ne répond pas" description="Vérifie ta connexion puis réessaie." [retrying]="retrying()" (retry)="retryAuth()" />
        }
        @case ('access-error') {
          <rj-error-state title="Raijin n’a pas pu vérifier ton accès au scan" [description]="service.accessError()?.message ?? ''" [retrying]="retrying()" (retry)="retryAccess()" />
        }
        @case ('signed-out') {
          <rj-card data-access="signed-out">
            <div class="flex flex-col gap-1">
              <h2 class="font-display text-h3 text-ink">Le scan de wallet fait partie de Raijin Pro</h2>
              <p class="text-body text-ink-muted">
                Crée un compte gratuit et confirme ton e-mail : ton essai Pro de 7 jours démarre automatiquement, sans carte bancaire. Il inclut le scan de wallet.
              </p>
            </div>
            <div class="border-t border-line pt-4"><ng-container *ngTemplateOutlet="featureList" /></div>
            <div rjCardFooter class="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap">
              <a rjButton="primary" routerLink="/compte/inscription" [queryParams]="redirect" icon="compte">Créer un compte</a>
              <a rjButton="secondary" routerLink="/compte/connexion" [queryParams]="redirect">Se connecter</a>
            </div>
          </rj-card>
        }
        @case ('plan') {
          <rj-card data-access="plan">
            <div class="flex flex-col gap-1">
              <h2 class="font-display text-h3 text-ink">Le scan de wallet fait partie du plan Pro</h2>
              <p class="text-body text-ink-muted" data-plan-text>{{ planText() }}</p>
            </div>
            <div class="border-t border-line pt-4"><ng-container *ngTemplateOutlet="featureList" /></div>
            <div rjCardFooter class="flex flex-wrap gap-2 pt-1">
              @if (auth.emailVerified()) {
                <a rjButton="primary" routerLink="/abonnement" icon="safe">Voir l’offre Pro</a>
              } @else {
                <a rjButton="primary" routerLink="/compte/verifier-email" icon="mail">Confirmer mon adresse</a>
              }
            </div>
          </rj-card>
        }
        @case ('scan') {
          <div class="flex flex-col gap-2">
            <form class="flex flex-col gap-3 lg:flex-row lg:items-start" novalidate autocomplete="off" (submit)="submit($event)">
              <rj-input-field
                #field
                class="lg:flex-1"
                label="Adresse publique du wallet"
                name="wallet"
                placeholder="Adresse du wallet"
                enterkeyhint="go"
                [mono]="true"
                [pasteable]="true"
                [maxlength]="128"
                [value]="input()"
                (valueChange)="onInput($event)"
                [error]="inputError()"
                [hint]="hint()"
                (pasted)="submitted.set(false)"
                (blurred)="touched.set(true)"
              />
              <div
                class="fixed inset-x-0 bottom-tabbar-edge z-30 border-t border-line bg-base/95 px-4 py-3 backdrop-blur-sm md:px-6 lg:static lg:z-auto lg:mt-7 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
              >
                <button type="submit" rjButton="primary" size="lg" icon="wallet" [block]="true" [loading]="service.loading()" [disabled]="service.quotaExhausted()" class="lg:w-auto">
                  Scanner
                </button>
              </div>
            </form>

            <div class="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div class="text-body-sm text-ink-muted" role="status" data-preview>
                @switch (state().kind) {
                  @case ('valid') {
                    <span class="inline-flex flex-wrap items-center gap-x-1.5">
                      <rj-icon name="circleCheck" [size]="16" class="text-safe" />
                      <span>Adresse reconnue :</span>
                      <span class="tabular text-ink" [attr.title]="address()">{{ shortAddress() }}</span>
                    </span>
                  }
                  @case ('mint') {
                    <a
                      [routerLink]="['/analyse', address()]"
                      class="-my-2 inline-flex min-h-11 items-center gap-1.5 rounded-sm font-medium text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                      data-analyse-token
                      ><rj-icon name="analyse" [size]="16" />Analyser ce token</a
                    >
                  }
                }
              </div>
              <p class="min-h-lh shrink-0 text-label text-ink-muted sm:pt-0.5 sm:text-right" data-quota>{{ quotaLabel() }}</p>
            </div>
          </div>

          <p class="sr-only" aria-live="polite">{{ announcement() }}</p>

          @switch (resultView()) {
            @case ('loading') {
              <div class="flex flex-col gap-4 md:gap-6" role="group" aria-busy="true" aria-label="Scan du wallet en cours">
                <p class="flex items-center gap-2 text-body-sm text-ink-muted">
                  <rj-icon name="loader" [size]="16" [spin]="true" class="shrink-0" />
                  Raijin lit les comptes de tokens et vérifie chaque token. Ça peut prendre jusqu’à 15 secondes.
                </p>
                <rj-skeleton shape="block" class="h-44 md:h-36" />
                <div class="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:grid-cols-3">
                  @for (card of skeletonCards; track card) {
                    <rj-card>
                      <div class="flex items-start justify-between gap-3">
                        <div class="flex flex-1 flex-col gap-2"><rj-skeleton class="h-5 w-32" /><rj-skeleton class="h-4 w-16" /></div>
                        <rj-skeleton class="h-7 w-24" />
                      </div>
                      <rj-skeleton class="h-4 w-40" />
                      <div class="flex flex-col gap-2"><rj-skeleton class="h-4 w-full" /><rj-skeleton class="h-4 w-3/4" /></div>
                      <div class="grid grid-cols-2 gap-3 pt-3"><rj-skeleton class="h-9" /><rj-skeleton class="h-9" /></div>
                      <rj-skeleton rjCardFooter shape="block" class="h-11" />
                    </rj-card>
                  }
                </div>
              </div>
            }
            @case ('quota') {
              <ng-container *ngTemplateOutlet="notice; context: { icon: 'clock', title: 'Scans du jour utilisés', text: quotaMessage }" />
            }
            @case ('is-token') {
              <rj-card role="status" data-error="WALLET_IS_TOKEN">
                <div class="flex items-start gap-3">
                  <span class="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface-raised text-info"><rj-icon name="info" [size]="20" /></span>
                  <div class="flex min-w-0 flex-col gap-1">
                    <h2 class="font-display text-h3 text-ink">C’est l’adresse d’un token</h2>
                    <p class="text-body text-ink-muted">{{ isTokenMessage }}</p>
                  </div>
                </div>
                <div rjCardFooter>
                  <a rjButton="secondary" icon="analyse" [routerLink]="['/analyse', lastAddress()]">Analyser ce token</a>
                </div>
              </rj-card>
            }
            @case ('too-large') {
              <ng-container *ngTemplateOutlet="notice; context: { icon: 'info', title: 'Wallet trop volumineux pour un scan', text: tooLargeMessage }" />
            }
            @case ('error') {
              <rj-error-state title="Le scan n’a pas abouti" [description]="service.error()?.message ?? ''" [retrying]="service.loading()" (retry)="retry()" />
            }
            @case ('empty') {
              <rj-empty-state title="Aucun token dans ce wallet" [description]="emptyText()" />
            }
            @case ('result') {
              @if (service.result(); as scan) {
                <div class="flex flex-col gap-6 md:gap-8" data-result>
                  @if (scan.delegations.length > 0) {
                    <rj-wallet-delegations [delegations]="scan.delegations" [total]="scan.summary.delegationCount" />
                  }

                  @if (scan.partial) {
                    <p class="flex items-start gap-3 rounded-lg border border-line-strong bg-surface-raised p-4 text-body text-ink" role="note" data-partial>
                      <rj-icon name="info" [size]="20" class="mt-0.5 shrink-0 text-info" />
                      <span>Résultat partiel : certains tokens n’ont pas pu être vérifiés à temps. Ouvre leur analyse complète, ou relance le scan dans quelques minutes.</span>
                    </p>
                  }

                  <rj-wallet-summary [scan]="scan" />

                  <section class="flex flex-col gap-4" aria-labelledby="rj-tokens-title">
                    <div class="flex flex-col gap-1">
                      <h2 id="rj-tokens-title" class="font-display text-h3 text-ink">Tokens détenus</h2>
                      <p class="text-body-sm text-ink-muted">
                        Triés par valeur indicative. Noms et symboles sont déclarés par les créateurs des tokens : Raijin ne peut pas les garantir, fie-toi à l’adresse.
                      </p>
                    </div>

                    @if (scan.tokens.length > 0) {
                      <ul class="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:grid-cols-3" aria-label="Tokens détenus" data-tokens>
                        @for (token of scan.tokens; track token.mint) {
                          <li class="min-w-0">
                            <rj-wallet-token-card [token]="token" [analyzedMax]="analyzedMax()" />
                          </li>
                        }
                      </ul>
                    } @else {
                      <p class="rounded-lg border border-line bg-surface p-4 text-body text-ink-muted">Aucun token avec un solde dans ce wallet.</p>
                    }

                    @if (hiddenCount() > 0) {
                      <p class="text-body-sm text-ink-muted">{{ hiddenText() }}</p>
                    }

                    <ul class="flex flex-col gap-2 text-body-sm text-ink-muted" aria-label="À savoir">
                      @if (hasLight()) {
                        <li class="flex items-start gap-2">
                          <rj-icon name="clock" [size]="16" class="mt-0.5 shrink-0" />
                          <span>Contrôle rapide : 6 contrôles sur 9. L’analyse complète ajoute la simulation de vente, le créateur et RugCheck.</span>
                        </li>
                      }
                      @if (hasSafe()) {
                        <li class="flex items-start gap-2">
                          <rj-icon name="safe" [size]="16" class="mt-0.5 shrink-0" />
                          <span>Sain : {{ safeReminder }}</span>
                        </li>
                      }
                    </ul>
                  </section>
                </div>
              }
            }
            @default {
              <rj-card>
                <h2 class="font-display text-h3 text-ink">Ce que Raijin vérifie</h2>
                <ng-container *ngTemplateOutlet="featureList" />
              </rj-card>
            }
          }
        }
      }

      <p class="text-label text-ink-muted" data-disclaimer>{{ disclaimer }} Les memecoins sont extrêmement risqués : ne mise que ce que tu peux perdre.</p>
    </div>

    <ng-template #featureList>
      <ul class="flex flex-col gap-3" data-features>
        @for (feature of features; track feature.text) {
          <li class="flex items-start gap-3 text-body text-ink">
            <rj-icon [name]="feature.icon" [size]="20" class="mt-0.5 shrink-0 text-ink-muted" />
            <span>{{ feature.text }}</span>
          </li>
        }
      </ul>
    </ng-template>

    <ng-template #notice let-icon="icon" let-title="title" let-text="text">
      <rj-card role="status">
        <div class="flex items-start gap-3">
          <span class="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface-raised text-info"><rj-icon [name]="icon" [size]="20" /></span>
          <div class="flex min-w-0 flex-col gap-1">
            <h2 class="font-display text-h3 text-ink">{{ title }}</h2>
            <p class="text-body text-ink-muted">{{ text }}</p>
          </div>
        </div>
      </rj-card>
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WalletPage {
  protected readonly auth = inject(AuthStore);
  protected readonly service = inject(WalletScanService);
  private readonly field = viewChild<RjInputField>('field');
  private readonly fieldHost = viewChild('field', { read: ElementRef<HTMLElement> });

  protected readonly readOnlyNotice = WALLET_SCAN_READ_ONLY_NOTICE;
  protected readonly disclaimer = ANALYSIS_DISCLAIMER;
  protected readonly safeReminder = SAFE_VERDICT_REMINDER.charAt(0).toLowerCase() + SAFE_VERDICT_REMINDER.slice(1);
  protected readonly quotaMessage = WALLET_ERROR_MESSAGES.WALLET_SCAN_QUOTA_EXCEEDED;
  protected readonly isTokenMessage = WALLET_ERROR_MESSAGES.WALLET_IS_TOKEN;
  protected readonly tooLargeMessage = WALLET_ERROR_MESSAGES.WALLET_TOO_LARGE;
  protected readonly features = SCAN_FEATURES;
  protected readonly skeletonCards = [1, 2, 3];
  protected readonly redirect = { redirect: '/wallet' };

  protected readonly input = signal('');
  protected readonly submitted = signal(false);
  protected readonly touched = signal(false);
  /** Une phrase de récupération vient d'être effacée du champ (seul le fait est gardé, jamais la valeur). */
  protected readonly seedRejected = signal(false);
  protected readonly retrying = signal(false);
  /** Dernière adresse envoyée (mémoire seulement : Réessayer, « Analyser ce token »). */
  protected readonly lastAddress = signal('');

  protected readonly state = computed(() => readWalletInput(this.input()));
  protected readonly address = computed(() => {
    const state = this.state();
    return state.kind === 'valid' || state.kind === 'mint' ? state.address : '';
  });
  protected readonly shortAddress = computed(() => truncateMiddle(this.address(), 6, 6));

  protected readonly inputError = computed(() => {
    if (this.seedRejected()) return INPUT_MESSAGES.seed;
    const state = this.state();
    switch (state.kind) {
      case 'seed':
      case 'mint':
      case 'program':
        return INPUT_MESSAGES[state.kind];
      case 'invalid':
        return this.submitted() || this.touched() ? INPUT_MESSAGES.invalid : '';
      case 'empty':
        return this.submitted() ? INPUT_MESSAGES.empty : '';
      default: {
        const error = this.service.error();
        return error?.code === 'WALLET_INVALID' && this.lastAddress() === state.address ? error.message : '';
      }
    }
  });
  protected readonly hint = computed(() =>
    this.state().kind === 'valid' ? '' : 'Ton adresse publique (bouton « Recevoir » de ton wallet). Jamais ta phrase de récupération ni ta clé privée.',
  );
  protected readonly quotaLabel = computed(() => walletQuotaText(this.service.quota()));

  protected readonly view = computed<View>(() => {
    if (this.auth.isLoading()) return 'loading';
    if (this.auth.status() === 'error') return 'auth-error';
    const access = this.service.access();
    if (!this.auth.isAuthenticated() || access === 'signed_out') return 'signed-out';
    switch (access) {
      case 'plan_required':
        return 'plan';
      case 'error':
        return 'access-error';
      case 'allowed':
        return 'scan';
      default:
        return 'loading';
    }
  });

  protected readonly resultView = computed(() => {
    switch (this.service.status()) {
      case 'loading':
        return 'loading';
      case 'ready': {
        const scan = this.service.result();
        return scan && scan.summary.tokenCount === 0 && scan.delegations.length === 0 ? 'empty' : 'result';
      }
      case 'error':
        switch (this.service.error()?.code) {
          case 'WALLET_SCAN_QUOTA_EXCEEDED':
            return 'quota';
          case 'WALLET_IS_TOKEN':
            return 'is-token';
          case 'WALLET_TOO_LARGE':
            return 'too-large';
          case 'WALLET_INVALID':
            return 'idle';
          default:
            return 'error';
        }
      default:
        return this.service.quotaExhausted() ? 'quota' : 'idle';
    }
  });

  protected readonly planText = computed(() => {
    const user = this.auth.user();
    if (!user?.emailVerified) {
      return 'Confirme ton adresse e-mail : ton essai Pro de 7 jours démarre alors automatiquement, sans carte bancaire. Il inclut le scan de wallet.';
    }
    if (user.trial.status === 'ended') {
      return 'Ton essai Pro est terminé. Le scan de wallet reste disponible avec le plan Pro, que tu peux activer depuis la page Abonnement quand tu le souhaites.';
    }
    return 'Le plan Pro ajoute le scan de wallet, plus de suivis et les alertes push. Tu peux l’activer depuis la page Abonnement quand tu le souhaites.';
  });

  protected readonly analyzedMax = computed(() => {
    const summary = this.service.result()?.summary;
    return summary ? summary.analyzedCount + summary.unavailableCount : 0;
  });
  protected readonly hasLight = computed(() =>
    (this.service.result()?.tokens ?? []).some((t) => t.assessment.status === 'analyzed' && t.assessment.coverage === 'light'),
  );
  protected readonly hasSafe = computed(() => (this.service.result()?.summary.verdicts.safe ?? 0) > 0);
  protected readonly hiddenCount = computed(() => {
    const scan = this.service.result();
    return scan ? scan.summary.tokenCount - scan.tokens.length : 0;
  });
  protected readonly hiddenText = computed(() => {
    const count = this.hiddenCount();
    return count > 1
      ? `${count} autres tokens de faible valeur ne sont pas listés.`
      : '1 autre token de faible valeur n’est pas listé.';
  });
  protected readonly emptyText = computed(() => {
    const summary = this.service.result()?.summary;
    const ignored: string[] = [];
    if (summary && summary.nftCount > 0) ignored.push(plural(summary.nftCount, 'NFT', 'NFT'));
    if (summary && summary.emptyAccountCount > 0) ignored.push(plural(summary.emptyAccountCount, 'compte vide', 'comptes vides'));
    const tail = ignored.length > 0 ? ` (ignorés : ${ignored.join(', ')})` : '';
    return `Raijin n’a trouvé aucun token avec un solde ni aucune délégation active à cette adresse${tail}.`;
  });
  protected readonly announcement = computed(() => {
    const scan = this.service.result();
    if (this.service.loading()) return 'Scan en cours.';
    if (!scan || this.service.status() !== 'ready') return '';
    return `Scan terminé : ${plural(scan.summary.tokenCount, 'token')}, ${plural(scan.summary.delegationCount, 'délégation active', 'délégations actives')}.`;
  });

  constructor() {
    // Accès au scan demandé une fois la session connue (visiteur : aucune requête).
    effect(() => {
      const authenticated = this.auth.isAuthenticated();
      untracked(() => {
        if (authenticated && this.service.access() === 'unknown') void this.service.checkAccess();
      });
    });
  }

  /**
   * Saisie (frappe ou Coller). Une phrase de récupération n'est jamais conservée : le champ et
   * le signal sont vidés aussitôt, avant tout calcul dérivé ou envoi.
   */
  protected onInput(value: string): void {
    if (looksLikeSeedPhrase(value)) {
      this.input.set('');
      this.field()?.value.set('');
      // Le rendu ne voit pas de changement ('' → '') : on vide aussi l'élément natif.
      const native = this.fieldHost()?.nativeElement.querySelector('input');
      if (native) native.value = '';
      this.submitted.set(false);
      this.seedRejected.set(true);
      return;
    }
    this.seedRejected.set(false);
    this.input.set(value);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.submitted.set(true);
    const state = this.state();
    if (state.kind !== 'valid') {
      this.field()?.focus();
      return;
    }
    await this.run(state.address);
  }

  protected retry(): void {
    const address = this.lastAddress();
    if (address) void this.run(address);
  }

  protected async retryAccess(): Promise<void> {
    this.retrying.set(true);
    await this.service.checkAccess();
    this.retrying.set(false);
  }

  protected async retryAuth(): Promise<void> {
    this.retrying.set(true);
    await this.auth.init(true);
    this.retrying.set(false);
  }

  private async run(address: string): Promise<void> {
    this.lastAddress.set(address);
    await this.service.scan(address);
  }
}
