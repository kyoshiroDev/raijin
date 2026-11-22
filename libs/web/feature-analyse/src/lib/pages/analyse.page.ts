import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { QuotaInfo } from '@raijin/shared-contracts';
import { extractSolanaAddress, isSolanaAddress, truncateMiddle, type AddressInputSource } from '@raijin/shared-util';
import { AnalysisStore, AuthStore } from '@raijin/web-data-access';
import { RjButton, RjCard, RjEmptyState, RjErrorState, RjIcon, RjInputField } from '@raijin/web-ui';
import { RjAnalysisLoading } from '../analysis/analysis-loading';
import { RjAnalysisResult } from '../analysis/analysis-result';
import { tokenDisplayName } from '../analysis/check-display';
import { ANALYSIS_CHECK_IDS, ANALYSIS_CHECK_LABELS, LOCAL_ERROR_MESSAGES, VERDICT_LABELS } from '../analysis/labels';
import { bindPageTitle } from '../analysis/page-title';

const SOURCE_LABELS: Readonly<Record<AddressInputSource, string>> = {
  raw: '',
  dexscreener: 'lien DexScreener',
  pumpfun: 'lien pump.fun',
  solscan: 'lien Solscan',
  birdeye: 'lien Birdeye',
};

const DEFAULT_HINT = 'Adresse du mint (32 à 44 caractères) ou lien DexScreener, pump.fun, Solscan ou Birdeye.';

/** Texte discret du quota restant. */
export function quotaText(quota: QuotaInfo): string {
  if (quota.remaining === null || quota.limit === null) return 'Analyses illimitées avec ton plan.';
  if (quota.remaining === 0) return 'Plus d’analyse disponible aujourd’hui : le compteur repart à minuit (UTC).';
  const plural = quota.remaining > 1 ? 'analyses' : 'analyse';
  return `Il te reste ${quota.remaining} ${plural} sur ${quota.limit} aujourd’hui.`;
}

/** Titre de l'erreur affichée avec Rai alerte. */
function errorTitle(code: string): string {
  switch (code) {
    case 'TOKEN_NOT_FOUND':
      return 'Aucun token à cette adresse';
    case 'UPSTREAM_UNAVAILABLE':
      return 'Sources de données indisponibles';
    case 'RATE_LIMITED':
      return 'Trop de demandes d’un coup';
    case 'NETWORK_ERROR':
      return 'Raijin ne répond pas';
    default:
      return 'Analyse impossible pour l’instant';
  }
}

/**
 * Écran « Analyser » (`/analyse`, `/analyse/:mint`) : saisie avec extraction immédiate de
 * l'adresse (lien DexScreener, pump.fun, Solscan, Birdeye), bouton « Analyser » collé au-dessus
 * de la barre d'onglets sur mobile (seule action jaune), puis chargement, résultat, état vide
 * ou erreur. Après une analyse, l'URL devient `/analyse/<mint>` (partageable, rechargeable).
 */
@Component({
  selector: 'rj-analyse-page',
  imports: [RouterLink, RjAnalysisLoading, RjAnalysisResult, RjButton, RjCard, RjEmptyState, RjErrorState, RjIcon, RjInputField],
  template: `
    <div class="flex flex-col gap-6 pb-24 md:gap-8 lg:pb-0">
      <header class="flex flex-col gap-1">
        <h1 class="font-display text-h2 text-ink md:text-h1">Analyser un token</h1>
        <p class="text-body text-ink-muted">9 contrôles de sécurité en lecture seule. Raijin ne signe jamais rien.</p>
      </header>

      <div class="flex flex-col gap-2">
        <form class="flex flex-col gap-3 lg:flex-row lg:items-start" novalidate (submit)="submit($event)">
          <rj-input-field
            #field
            class="lg:flex-1"
            label="Adresse ou lien du token"
            name="token"
            placeholder="Adresse ou lien"
            inputmode="url"
            enterkeyhint="go"
            [mono]="true"
            [pasteable]="true"
            [(value)]="input"
            [error]="inputError()"
            [hint]="hint()"
            (pasted)="onPasted()"
          />
          <div
            class="fixed inset-x-0 bottom-tabbar-edge z-30 border-t border-line bg-base/95 px-4 py-3 backdrop-blur-sm md:px-6 lg:static lg:z-auto lg:mt-7 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
          >
            <button type="submit" rjButton="primary" size="lg" icon="analyse" [block]="true" [loading]="store.loading()" class="lg:w-auto">
              Analyser
            </button>
          </div>
        </form>

        <div class="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <p class="text-body-sm text-ink-muted" role="status" data-preview>
            @if (preview(); as preview) {
              <span class="inline-flex flex-wrap items-center gap-x-1.5">
                <rj-icon name="circleCheck" [size]="16" class="text-safe" />
                <span>{{ preview.label }}</span>
                <span class="tabular text-ink" [attr.title]="preview.address">{{ preview.short }}</span>
              </span>
              @if (preview.pair) {
                <span class="block">Si c’est une paire, Raijin retrouve le token correspondant.</span>
              }
            }
          </p>
          @if (store.quota(); as quota) {
            <p class="shrink-0 text-label text-ink-muted sm:pt-0.5 sm:text-right" data-quota>{{ quotaLabel() }}</p>
          }
        </div>
      </div>

      @switch (view()) {
        @case ('loading') {
          <rj-analysis-loading />
        }
        @case ('result') {
          @if (store.result(); as result) {
            <rj-analysis-result [result]="result" mode="private" />
          }
        }
        @case ('quota') {
          <rj-card role="status">
            <div class="flex items-start gap-3">
              <span class="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface-raised text-info">
                <rj-icon name="clock" [size]="20" />
              </span>
              <div class="flex min-w-0 flex-col gap-1">
                <h2 class="font-display text-h3 text-ink">Quota du jour atteint</h2>
                <p class="text-body text-ink-muted">{{ store.error()?.message }}</p>
              </div>
            </div>
            @if (anonymous()) {
              <div rjCardFooter class="flex flex-col items-start gap-3">
                <p class="text-body text-ink-muted">Avec un compte gratuit, tu as plus d’analyses chaque jour.</p>
                <a rjButton="secondary" routerLink="/compte/inscription" icon="compte">Créer un compte gratuit</a>
              </div>
            }
          </rj-card>
        }
        @case ('error') {
          <rj-error-state
            [title]="errorTitle()"
            [description]="store.error()?.message ?? ''"
            [retrying]="store.loading()"
            (retry)="retry()"
          />
        }
        @case ('empty') {
          <div class="flex flex-col gap-4 md:gap-6">
            <rj-empty-state
              title="Vérifie avant de signer"
              description="Colle l’adresse d’un token Solana ou un lien : Raijin te montre ce qu’il a vérifié, et ce qu’il n’a pas pu vérifier."
            />
            <rj-card>
              <h2 class="font-display text-h3 text-ink">Ce que Raijin vérifie</h2>
              <ul class="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                @for (label of checkLabels; track label) {
                  <li class="flex items-center gap-2 text-body text-ink">
                    <rj-icon name="safe" [size]="16" class="shrink-0 text-ink-muted" />{{ label }}
                  </li>
                }
              </ul>
            </rj-card>
          </div>
        }
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnalysePage {
  protected readonly store = inject(AnalysisStore);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly field = viewChild.required<RjInputField>('field');

  /** Paramètre de route `:mint` (absent sur `/analyse`). */
  readonly mint = input<string>();

  protected readonly input = signal('');
  private readonly submitted = signal(false);
  private lastInput = '';

  protected readonly checkLabels = ANALYSIS_CHECK_IDS.map((id) => ANALYSIS_CHECK_LABELS[id]);
  protected readonly extracted = computed(() => extractSolanaAddress(this.input()));
  protected readonly preview = computed(() => {
    const extracted = this.extracted();
    if (!extracted) return null;
    const source = SOURCE_LABELS[extracted.source];
    return {
      label: source ? `Adresse reconnue dans le ${source} :` : 'Adresse reconnue :',
      address: extracted.address,
      short: truncateMiddle(extracted.address, 6, 6),
      pair: extracted.kind === 'pair_or_mint',
    };
  });
  protected readonly inputError = computed(() => {
    if (this.extracted()) return '';
    if (this.store.error()?.code === 'MINT_INVALID') return LOCAL_ERROR_MESSAGES.MINT_INVALID;
    if (!this.submitted()) return '';
    return this.input().trim() ? LOCAL_ERROR_MESSAGES.MINT_INVALID : 'Colle l’adresse d’un token ou un lien pour lancer l’analyse.';
  });
  protected readonly hint = computed(() => (this.preview() ? '' : DEFAULT_HINT));
  protected readonly quotaLabel = computed(() => {
    const quota = this.store.quota();
    return quota ? quotaText(quota) : '';
  });
  protected readonly anonymous = computed(() => (this.store.quota()?.subject ?? (this.auth.isAuthenticated() ? 'user' : 'anonymous')) === 'anonymous');
  protected readonly errorTitle = computed(() => errorTitle(this.store.error()?.code ?? ''));

  protected readonly view = computed(() => {
    switch (this.store.status()) {
      case 'loading':
        return 'loading';
      case 'ready':
        return 'result';
      case 'error': {
        const code = this.store.error()?.code;
        if (code === 'QUOTA_EXCEEDED') return 'quota';
        // Adresse invalide : signalée sur le champ, l'écran reste sur l'état vide.
        return code === 'MINT_INVALID' ? 'empty' : 'error';
      }
      default:
        return 'empty';
    }
  });

  constructor() {
    void this.store.refreshQuota();
    bindPageTitle(
      computed(() => {
        const result = this.store.result();
        if (!this.mint() || !result || this.store.status() !== 'ready') return null;
        return `${VERDICT_LABELS[result.verdict]} · ${tokenDisplayName(result.token, result.mint)} — Raijin`;
      }),
    );
    effect(() => {
      const mint = this.mint();
      untracked(() => this.onRouteMint(mint));
    });
  }

  protected onPasted(): void {
    // Lien ou adresse collé : l'aperçu s'affiche, on ne lance pas l'analyse sans geste explicite.
    this.submitted.set(false);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.submitted.set(true);
    if (!this.extracted()) {
      this.field().focus();
      return;
    }
    await this.run(this.input());
  }

  protected retry(): void {
    void this.run(this.lastInput);
  }

  private async run(input: string): Promise<void> {
    this.lastInput = input;
    const ok = await this.store.analyze(input);
    const result = this.store.result();
    if (ok && result && this.mint() !== result.mint) {
      await this.router.navigate(['/analyse', result.mint]);
    }
  }

  /** Vrai si la navigation en cours, ou l'URL courante, vise `/analyse/<mint>`. */
  private targetsMintRoute(): boolean {
    const navigation = this.router.currentNavigation();
    const target = navigation ? this.router.serializeUrl(navigation.finalUrl ?? navigation.extractedUrl) : this.router.url;
    return /^\/analyse\/[^/?#]+/.test(target);
  }

  private onRouteMint(mint: string | undefined): void {
    if (!mint) {
      // Retour sur `/analyse` : état vide. Jamais pendant une analyse, ni quand la navigation
      // en cours (ou déjà faite) mène à `/analyse/<mint>` : l'ordre de création des composants
      // et d'exécution des effets ne doit pas pouvoir effacer un résultat qui vient d'arriver.
      if (this.store.loading() || this.targetsMintRoute()) return;
      this.store.reset();
      return;
    }
    this.input.set(mint);
    if (!isSolanaAddress(mint)) {
      this.store.setLocalError({ code: 'MINT_INVALID', message: LOCAL_ERROR_MESSAGES.MINT_INVALID, status: 0 });
      return;
    }
    const current = this.store.result();
    if (this.store.loading() || (current?.mint === mint && this.store.status() === 'ready')) return;
    void this.run(mint);
  }
}
