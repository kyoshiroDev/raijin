import { ChangeDetectionStrategy, Component, computed, model } from '@angular/core';
import { DEFAULT_FILTERS, activeFilterCount, type OpportunityFilters } from '@raijin/bench-web-logic/opportunities';

const MC_OPTIONS: { label: string; value: number | null }[] = [
  { label: '≤ 1 M$', value: 1_000_000 },
  { label: '≤ 5 M$', value: 5_000_000 },
  { label: '≤ 20 M$', value: 20_000_000 },
  { label: '≤ 100 M$', value: 100_000_000 },
  { label: 'Toutes', value: null },
];

@Component({
  selector: 'app-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      <input
        type="search"
        class="field"
        aria-label="Rechercher un token"
        enterkeyhint="search"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="Symbole, nom ou adresse…"
        maxlength="64"
        [value]="filters().search"
        (input)="patch({ search: value($event) })"
      />
      <div class="space-y-2" role="group" aria-labelledby="mc-label">
        <p id="mc-label" class="text-sm">Market cap maximum</p>
        <div class="flex flex-wrap gap-2">
          @for (opt of mcOptions; track opt.label) {
            <button
              type="button"
              class="pill press min-h-11 border border-line px-3.5 text-sm"
              [class.seg-active]="filters().maxMarketCap === opt.value"
              [attr.aria-pressed]="filters().maxMarketCap === opt.value"
              (click)="patch({ maxMarketCap: opt.value })"
            >
              {{ opt.label }}
            </button>
          }
        </div>
      </div>
      <div class="flex flex-col text-sm">
        <label class="flex min-h-11 items-center gap-2">
          <input type="checkbox" class="size-5 shrink-0 accent-fg" [checked]="filters().hideRisky" (change)="patch({ hideRisky: checked($event) })" />
          Masquer les tokens risqués
        </label>
        <label class="flex min-h-11 items-center gap-2 py-1">
          <input
            type="checkbox"
            class="size-5 shrink-0 accent-fg"
            [checked]="filters().hideBondingCurves"
            (change)="patch({ hideBondingCurves: checked($event) })"
          />
          <span>
            Masquer les bonding curves
            <span class="block text-xs text-muted">Encore sur la courbe pump.fun : pas de vrai pool DEX</span>
          </span>
        </label>
      </div>
      <button type="button" class="btn-ghost w-full" [disabled]="isDefault()" (click)="reset()">Réinitialiser les filtres</button>
    </div>
  `,
})
export class FilterBar {
  readonly filters = model.required<OpportunityFilters>();
  protected readonly mcOptions = MC_OPTIONS;

  protected readonly isDefault = computed(() => activeFilterCount(this.filters()) === 0);

  /** Back to the default sheet filters; « Afficher les tokens anciens » (page switch) is kept. */
  reset(): void {
    this.filters.update((f) => ({ ...DEFAULT_FILTERS, showOld: f.showOld }));
  }

  patch(change: Partial<OpportunityFilters>): void {
    this.filters.update((f) => ({ ...f, ...change }));
  }

  protected value(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected checked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }
}
