import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, untracked } from '@angular/core';
import { Meta } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import type { AnalysisResult } from '@raijin/shared-contracts';
import { isSolanaAddress, truncateMiddle } from '@raijin/shared-util';
import { AnalysisStore } from '@raijin/web-data-access';
import { RjButton, RjEmptyState, RjErrorState } from '@raijin/web-ui';
import { RjAnalysisLoading } from '../analysis/analysis-loading';
import { RjAnalysisResult } from '../analysis/analysis-result';
import { tokenDisplayName } from '../analysis/check-display';
import { ANALYSIS_DISCLAIMER, LOCAL_ERROR_MESSAGES, VERDICT_LABELS } from '../analysis/labels';
import { bindPageTitle } from '../analysis/page-title';
import { publicTokenUrl } from '../analysis/share';

/** Titre et description de la page publique (texte du token entre guillemets : non fiable). */
export function publicPageMeta(result: AnalysisResult): { title: string; description: string } {
  const verdict = VERDICT_LABELS[result.verdict];
  const name = tokenDisplayName(result.token, result.mint);
  return {
    title: `Verdict ${verdict} pour « ${name} » — Raijin Shield`,
    description: `Raijin Shield a vérifié 9 points de sécurité du token « ${name} » (${truncateMiddle(result.mint)}) : verdict ${verdict}. ${ANALYSIS_DISCLAIMER}`,
  };
}

/**
 * Page publique `/t/<mint>`, sans compte : dernière analyse publiée (sans quota), même rendu
 * que l'écran d'analyse en lecture, appel à l'action « Analyser un autre token ». Les balises
 * Open Graph sont injectées côté serveur par l'API (robots sans JS) ; ici on met à jour le
 * titre et la description pour le navigateur.
 */
@Component({
  selector: 'rj-public-token-page',
  imports: [RouterLink, RjAnalysisLoading, RjAnalysisResult, RjButton, RjEmptyState, RjErrorState],
  template: `
    <div class="flex flex-col gap-6 md:gap-8">
      <header class="flex flex-col gap-1">
        <p class="text-label font-medium tracking-wide text-ink-muted uppercase">Analyse partagée</p>
        <h1 class="font-display text-h2 text-ink md:text-h1">Verdict Raijin</h1>
        <p class="text-body text-ink-muted">Dernière analyse publiée pour ce token, vérifiable par tous.</p>
      </header>

      @switch (store.status()) {
        @case ('ready') {
          @if (store.result(); as result) {
            <rj-analysis-result [result]="result" mode="public">
              <div rjResultActions class="flex flex-col gap-2">
                <a rjButton="primary" size="lg" routerLink="/analyse" icon="analyse" [block]="true">Analyser un autre token</a>
                <a rjButton="ghost" [routerLink]="['/analyse', result.mint]" icon="retry" [block]="true">Réanalyser ce token</a>
              </div>
            </rj-analysis-result>
          }
        }
        @case ('error') {
          @switch (store.error()?.code) {
            @case ('ANALYSIS_NOT_FOUND') {
              <rj-empty-state title="Pas encore d’analyse récente" [description]="notFoundMessage">
                <a rjButton="primary" [routerLink]="['/analyse', mint()]" icon="analyse">Analyser ce token</a>
              </rj-empty-state>
            }
            @case ('MINT_INVALID') {
              <rj-empty-state title="Adresse non reconnue" description="Ce lien ne contient pas d’adresse de token Solana valide.">
                <a rjButton="primary" routerLink="/analyse" icon="analyse">Analyser un token</a>
              </rj-empty-state>
            }
            @default {
              <rj-error-state
                title="Raijin n’a pas pu charger cette analyse"
                [description]="store.error()?.message ?? ''"
                [retrying]="store.loading()"
                (retry)="load()"
              />
            }
          }
        }
        @default {
          <rj-analysis-loading title="Chargement de l’analyse" description="Raijin récupère la dernière analyse publiée de ce token." />
        }
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicTokenPage {
  protected readonly store = inject(AnalysisStore);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);

  readonly mint = input.required<string>();

  protected readonly notFoundMessage = LOCAL_ERROR_MESSAGES.ANALYSIS_NOT_FOUND;
  private readonly pageMeta = computed(() => {
    const result = this.store.result();
    return result && this.store.status() === 'ready' ? publicPageMeta(result) : null;
  });

  constructor() {
    const initialDescription = this.meta.getTag('name="description"')?.content ?? null;
    bindPageTitle(computed(() => this.pageMeta()?.title ?? null));
    effect(() => {
      const meta = this.pageMeta();
      const mint = this.mint();
      if (!meta) return;
      untracked(() => {
        const url = publicTokenUrl(this.document.defaultView?.location.origin ?? '', mint);
        this.meta.updateTag({ name: 'description', content: meta.description });
        this.meta.updateTag({ property: 'og:title', content: meta.title });
        this.meta.updateTag({ property: 'og:description', content: meta.description });
        this.meta.updateTag({ property: 'og:url', content: url });
      });
    });
    effect(() => {
      this.mint();
      untracked(() => this.load());
    });
    inject(DestroyRef).onDestroy(() => {
      if (initialDescription !== null) this.meta.updateTag({ name: 'description', content: initialDescription });
      this.meta.removeTag('property="og:title"');
      this.meta.removeTag('property="og:description"');
      this.meta.removeTag('property="og:url"');
    });
  }

  protected load(): void {
    const mint = this.mint();
    if (!isSolanaAddress(mint)) {
      this.store.setLocalError({ code: 'MINT_INVALID', message: LOCAL_ERROR_MESSAGES.MINT_INVALID, status: 0 });
      return;
    }
    void this.store.loadLatest(mint);
  }
}
