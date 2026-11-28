import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { WalletToken } from '@raijin/shared-contracts';
import { RjAddressChip, RjButton, RjCard, RjIcon, RjVerdictBadge } from '@raijin/web-ui';
import { assessmentStatus, coverageText, formatAmount, formatUsd, hasName, tokenLabel, tokenSymbol } from './format';

/**
 * Carte d'un token détenu : nom (non fiable, texte), verdict (icône + mot) et sa profondeur
 * (« Contrôle rapide (6/9) » ou « Analyse complète »), explication, solde compact (valeur exacte
 * en `title`), valeur indicative, signaux du compte (gelé, délégation), lien vers l'analyse
 * complète. Pleine hauteur de sa cellule : les cartes d'une même rangée ont la même hauteur.
 */
@Component({
  selector: 'rj-wallet-token-card',
  imports: [RouterLink, RjAddressChip, RjButton, RjCard, RjIcon, RjVerdictBadge],
  template: `
    <rj-card>
      <div class="flex items-start justify-between gap-3">
        <h3 class="flex min-w-0 flex-col">
          <span
            [class]="'truncate font-display text-h3 ' + (named() ? 'text-ink' : 'font-mono text-body text-ink-muted')"
            [attr.title]="name()"
            data-token-name
            >{{ name() }}</span
          >
          @if (symbol(); as symbol) {
            <span class="truncate text-body-sm text-ink-muted" data-token-symbol>{{ symbol }}</span>
          }
        </h3>
        @if (analyzed(); as analyzed) {
          <rj-verdict-badge [verdict]="analyzed.verdict" />
        } @else if (status(); as status) {
          <span class="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-line-strong px-2 py-1 text-body-sm font-semibold text-ink-muted" data-status>
            <rj-icon name="unavailable" [size]="16" />{{ status.label }}
          </span>
        }
      </div>

      @if (analyzed(); as analyzed) {
        <p class="-mt-1 flex flex-wrap items-center gap-x-1.5 text-label font-medium text-ink-muted" data-coverage>
          <rj-icon [name]="analyzed.coverage === 'light' ? 'clock' : 'circleCheck'" [size]="16" class="shrink-0" />
          <span>{{ coverage() }}</span>
          @if (analyzed.degraded) {
            <span aria-hidden="true">·</span><span>données partielles</span>
          }
        </p>
        <p class="line-clamp-3 text-body-sm text-ink" [attr.title]="analyzed.explanation">{{ analyzed.explanation }}</p>
      } @else if (status(); as status) {
        <p class="text-body-sm text-ink-muted">{{ status.text }}</p>
      }

      @if (!named()) {
        <rj-address-chip [address]="token().mint" label="Adresse du token" />
      }

      @if (token().frozen || token().delegated) {
        <ul class="flex flex-wrap gap-2" aria-label="Signaux du compte">
          @if (token().frozen) {
            <li class="inline-flex items-center gap-1.5 rounded-sm border border-line-strong bg-surface-raised px-2 py-1 text-label font-medium text-ink" title="L’autorité de freeze du token a gelé au moins un de tes comptes : tu ne peux pas déplacer ces tokens.">
              <rj-icon name="pause" [size]="16" class="text-danger" />Compte gelé
            </li>
          }
          @if (token().delegated) {
            <li class="inline-flex items-center gap-1.5 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1 text-label font-medium text-warn">
              <rj-icon name="warn" [size]="16" />Délégation active
            </li>
          }
        </ul>
      }

      <dl class="mt-auto grid grid-cols-2 gap-3 border-t border-line pt-3">
        <div class="flex min-w-0 flex-col gap-0.5">
          <dt class="text-label text-ink-muted">Solde</dt>
          <dd class="tabular truncate text-body text-ink" [attr.title]="balance().exact" data-balance>{{ balance().short }}</dd>
        </div>
        <div class="flex min-w-0 flex-col gap-0.5">
          <dt class="text-label text-ink-muted">Valeur indicative</dt>
          <dd class="tabular truncate text-body" [class.text-ink]="token().valueUsd !== null" [class.text-ink-muted]="token().valueUsd === null" [attr.title]="value().exact" data-value>{{ value().short }}</dd>
        </div>
      </dl>

      <a rjCardFooter rjButton="secondary" [block]="true" iconEnd="arrowRight" [routerLink]="['/analyse', token().mint]" [attr.aria-label]="'Voir l’analyse complète de ' + name()" data-analysis-link>
        Voir l’analyse complète
      </a>
    </rj-card>
  `,
  host: { class: 'block h-full min-w-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjWalletTokenCard {
  readonly token = input.required<WalletToken>();
  /** Nombre maximal de tokens analysés par scan (explication « au-delà de la limite »). */
  readonly analyzedMax = input(0);

  protected readonly name = computed(() => tokenLabel(this.token().token, this.token().mint));
  protected readonly named = computed(() => hasName(this.token().token));
  protected readonly symbol = computed(() => tokenSymbol(this.token().token));
  protected readonly analyzed = computed(() => {
    const assessment = this.token().assessment;
    return assessment.status === 'analyzed' ? assessment : null;
  });
  protected readonly status = computed(() => {
    const assessment = this.token().assessment;
    return assessment.status === 'analyzed' ? null : assessmentStatus(assessment, this.analyzedMax());
  });
  protected readonly coverage = computed(() => {
    const analyzed = this.analyzed();
    return analyzed ? coverageText(analyzed) : '';
  });
  protected readonly balance = computed(() => formatAmount(this.token().balance, this.token().token.symbol));
  protected readonly value = computed(() => formatUsd(this.token().valueUsd));
}
