import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { VERDICT_LABELS, type Verdict, type WalletScanResult } from '@raijin/shared-contracts';
import { RjAddressChip, RjIcon } from '@raijin/web-ui';
import { formatScanTime, formatUsd, plural } from './format';

const VERDICT_TONES: Readonly<Record<Verdict, string>> = {
  safe: 'border-safe/40 bg-safe/10 text-safe',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-danger/40 bg-danger/10 text-danger',
};

/**
 * Résumé du scan : wallet scanné (tronqué au milieu, copie), nombre de tokens, valeur indicative,
 * délégations, répartition des verdicts (icône + mot + nombre), puis ce qui n'a pas été analysé
 * (poussière, au-delà de la limite, indisponible) et ce qui est ignoré (NFT, comptes vides).
 */
@Component({
  selector: 'rj-wallet-summary',
  imports: [RjAddressChip, RjIcon],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 md:gap-5 md:p-6" aria-labelledby="rj-summary-title" data-summary>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex min-w-0 flex-col gap-1">
          <h2 id="rj-summary-title" class="font-display text-h3 text-ink">Résumé du wallet</h2>
          <p class="text-body-sm text-ink-muted">
            Scanné le <time [attr.datetime]="scan().scannedAt">{{ time() }}</time>
            @if (scan().cached) {
              <span> · résultat récent réutilisé</span>
            }
          </p>
        </div>
        <rj-address-chip [address]="scan().address" label="Wallet scanné" [head]="6" [tail]="6" />
      </div>

      <dl class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="flex min-w-0 flex-col justify-between gap-1 rounded-md bg-surface-raised p-3">
          <dt class="text-label text-ink-muted">Tokens détenus</dt>
          <dd class="tabular text-h3 sm:text-h2 md:text-metric text-ink" data-token-count>{{ summary().tokenCount }}</dd>
        </div>
        <div class="flex min-w-0 flex-col justify-between gap-1 rounded-md bg-surface-raised p-3">
          <dt class="text-label text-ink-muted">Analysés</dt>
          <dd class="tabular text-h3 sm:text-h2 md:text-metric text-ink">{{ summary().analyzedCount }}</dd>
        </div>
        <div class="flex min-w-0 flex-col justify-between gap-1 rounded-md bg-surface-raised p-3">
          <dt class="text-label text-ink-muted">Délégations actives</dt>
          <dd class="tabular flex items-center gap-2 text-h3 sm:text-h2 md:text-metric" [class.text-warn]="summary().delegationCount > 0" [class.text-ink]="summary().delegationCount === 0" data-delegation-count>
            @if (summary().delegationCount > 0) {
              <rj-icon name="warn" [size]="20" />
            }
            {{ summary().delegationCount }}
          </dd>
        </div>
        <div class="flex min-w-0 flex-col justify-between gap-1 rounded-md bg-surface-raised p-3">
          <dt class="text-label text-ink-muted">Valeur indicative</dt>
          <dd class="tabular truncate text-h3 sm:text-h2 md:text-metric text-ink" [attr.title]="total().exact">{{ total().short }}</dd>
        </div>
      </dl>

      @if (summary().analyzedCount > 0) {
        <div class="flex flex-col gap-2">
          <h3 class="text-body-sm font-medium text-ink">Verdicts des tokens analysés</h3>
          <ul class="flex flex-wrap gap-2" aria-label="Répartition des verdicts" data-verdicts>
            @for (item of verdicts(); track item.verdict) {
              <li [class]="'inline-flex min-h-11 items-center gap-2 rounded-sm border px-3 text-body-sm font-semibold ' + item.tone" [attr.data-verdict-count]="item.verdict">
                <rj-icon [name]="item.verdict" [size]="16" />
                <span>{{ item.label }}</span>
                <span class="tabular text-ink">{{ item.count }}</span>
              </li>
            }
          </ul>
        </div>
      }

      @if (others().length > 0) {
        <ul class="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-body-sm text-ink-muted" aria-label="Non analysés et ignorés" data-others>
          @for (other of others(); track other) {
            <li>{{ other }}</li>
          }
        </ul>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjWalletSummary {
  readonly scan = input.required<WalletScanResult>();

  protected readonly summary = computed(() => this.scan().summary);
  protected readonly time = computed(() => formatScanTime(this.scan().scannedAt));
  protected readonly total = computed(() => formatUsd(this.summary().totalValueUsd));
  protected readonly verdicts = computed(() =>
    (['danger', 'warn', 'safe'] as const).map((verdict) => ({
      verdict,
      label: VERDICT_LABELS[verdict],
      count: this.summary().verdicts[verdict],
      tone: VERDICT_TONES[verdict],
    })),
  );
  protected readonly others = computed(() => {
    const s = this.summary();
    const items: string[] = [];
    if (s.dustCount > 0) items.push(`${plural(s.dustCount, 'poussière')} non analysée${s.dustCount > 1 ? 's' : ''}`);
    if (s.overLimitCount > 0) items.push(`${plural(s.overLimitCount, 'token')} au-delà de la limite d’analyse`);
    if (s.unavailableCount > 0) items.push(`${plural(s.unavailableCount, 'token')} indisponible${s.unavailableCount > 1 ? 's' : ''}`);
    if (s.nftCount > 0) items.push(`${plural(s.nftCount, 'NFT', 'NFT')} ignoré${s.nftCount > 1 ? 's' : ''}`);
    if (s.emptyAccountCount > 0) items.push(`${plural(s.emptyAccountCount, 'compte vide', 'comptes vides')}`);
    return items;
  });
}
