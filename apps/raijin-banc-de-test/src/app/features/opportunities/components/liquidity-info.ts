import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { TokenRow } from '../../../shared/models/token';
import { formatUsd } from '../../../shared/utils/format';
import { liquidityMethodText, liquiditySummary } from '../liquidity-sources';
import { Icon } from '../../../shared/ui/icon';

let nextId = 0;

const PCT0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/**
 * Effective liquidity + a disclosure button listing the per-source values. Tap/click/Enter
 * toggles (no hover: mobile has none); Escape or a tap outside closes; Escape returns focus to
 * the button. `inline` renders the panel in the flow (detail), otherwise as a dropdown (card).
 */
@Component({
  selector: 'app-liquidity-info',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pointer-events-auto relative block min-w-0', '(keydown)': 'onKeydown($event)' },
  template: `
    @let s = summary();
    <div class="flex min-w-0 items-center">
      <span class="truncate" data-liquidity-value>{{ fmtUsd(s.effective) }}</span>
      <button
        #trigger
        type="button"
        class="-my-3 -mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:text-fg"
        [class.text-bear]="s.incoherent"
        aria-label="Détail des sources de liquidité"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="panelId"
        (click)="toggle()"
      >
        <app-icon name="info" class="size-4" />
      </button>
    </div>
    @if (open()) {
      <div
        [id]="panelId"
        role="group"
        aria-label="Sources de liquidité"
        class="space-y-2 rounded-xl border border-line bg-surface-2 p-3 text-xs text-fg shadow-xl"
        [class]="inline() ? 'mt-2' : 'absolute top-full right-0 z-20 mt-1 w-64 max-w-[calc(100vw-2rem)]'"
      >
        <p class="font-semibold">Sources de liquidité</p>
        <ul class="space-y-1 tabular-nums slashed-zero">
          @for (src of s.sources; track src.id) {
            <li class="flex items-baseline justify-between gap-3" [attr.data-source]="src.id">
              <span class="text-muted">
                {{ src.label }}@if (src.role === 'control') {<span class="block text-label"> contrôle (non utilisé dans les calculs)</span>}
              </span>
              <span [class.font-semibold]="src.used">
                {{ src.value === null ? 'inconnue' : fmtUsd(src.value) }}@if (src.used) { (utilisée)}
              </span>
            </li>
          }
        </ul>
        <p class="text-muted">
          {{ methodText() }}
        </p>
        @if (s.divergencePct === null) {
          <p class="text-muted">Écart DexScreener / GeckoTerminal : inconnu</p>
        } @else if (s.incoherent) {
          <p class="text-bear" data-incoherent><strong class="font-bold">Données incohérentes</strong> : écart de {{ pct(s.divergencePct) }} % entre DexScreener et GeckoTerminal.</p>
        } @else {
          <p class="text-muted">Écart DexScreener / GeckoTerminal : {{ pct(s.divergencePct) }} %</p>
        }
      </div>
    }
  `,
})
export class LiquidityInfo {
  readonly token = input.required<TokenRow>();
  readonly inline = input(false);

  protected readonly panelId = `liquidity-sources-${++nextId}`;
  protected readonly open = signal(false);
  protected readonly summary = computed(() => liquiditySummary(this.token()));
  protected readonly methodText = computed(() => liquidityMethodText(this.summary()));
  protected readonly fmtUsd = formatUsd;

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly host: HTMLElement = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);
  private readonly onOutside = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && !this.host.contains(target)) this.close(false);
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => this.document.removeEventListener('pointerdown', this.onOutside, true));
  }

  protected pct(value: number): string {
    return PCT0.format(value);
  }

  protected toggle(): void {
    if (this.open()) this.close(false);
    else {
      this.open.set(true);
      this.document.addEventListener('pointerdown', this.onOutside, true);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.open()) return;
    // Handled here so an enclosing sheet (dialog) stays open.
    event.preventDefault();
    event.stopPropagation();
    this.close(true);
  }

  private close(returnFocus: boolean): void {
    this.open.set(false);
    this.document.removeEventListener('pointerdown', this.onOutside, true);
    if (returnFocus) this.trigger().nativeElement.focus();
  }
}
