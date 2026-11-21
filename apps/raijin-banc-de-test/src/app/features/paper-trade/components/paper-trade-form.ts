import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from '@angular/core';
import { PAPER_SLIPPAGE } from '../../../shared/models/paper';
import { parseDecimalInput } from '../../../shared/utils/decimal';
import { formatPrice, formatSolAmount } from '../../../shared/utils/format';
import { formatInputNumber, tradeSummary, validateDraft, type DraftField, type PaperDraft } from '../paper-strategy';
import { TradeSummaryView } from './trade-summary';

type DraftText = Record<DraftField, string>;

interface FieldDef {
  key: DraftField;
  label: string;
  mode: 'decimal' | 'numeric';
}

const FIELDS: readonly FieldDef[] = [
  { key: 'stake', label: 'Mise (SOL)', mode: 'decimal' },
  { key: 'slPct', label: 'Stop (% sous l’entrée)', mode: 'numeric' },
];

const toText = (d: PaperDraft): DraftText => ({
  stake: formatInputNumber(d.stake),
  slPct: Number.isFinite(d.slPct) ? String(d.slPct) : '',
});

const parseInteger = (t: string): number => (/^\s*\d+\s*$/.test(t) ? Number(t) : Number.NaN);

let nextId = 0;

/**
 * Paper trade form (presentational): strategy « Tout à ×2 » (fixed), market entry at the current price (shown, not
 * editable), editable stake and stop %. Emits a valid draft only.
 */
@Component({
  selector: 'app-paper-trade-form',
  imports: [TradeSummaryView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <form class="space-y-4" novalidate (submit)="submit($event)">
      <div class="space-y-0.5 rounded-xl bg-surface-2 p-3 text-sm" data-strategy="all_x2">
        <p class="font-semibold">Stratégie : tout à ×2</p>
        <p class="text-xs text-muted tabular-nums slashed-zero" data-entry>
          Entrée au prix actuel ({{ entryLabel() }}), toute la position vendue à ×2 ou au stop.
        </p>
      </div>
      <div class="grid grid-cols-2 gap-3">
        @for (f of fields; track f.key) {
          <div class="space-y-1">
            <label [for]="uid + f.key" class="block text-xs font-semibold text-muted">{{ f.label }}</label>
            <input
              [id]="uid + f.key"
              type="text"
              class="field font-mono tabular-nums slashed-zero"
              autocomplete="off"
              [attr.inputmode]="f.mode"
              [attr.data-field]="f.key"
              [value]="text()[f.key]"
              [attr.aria-invalid]="!!errors()[f.key]"
              [attr.aria-describedby]="uid + f.key + '-msg'"
              (input)="edit(f.key, $event)"
            />
            <p [id]="uid + f.key + '-msg'" class="text-label" [class.text-bear]="!!errors()[f.key]" [class.text-muted]="!errors()[f.key]">
              {{ errors()[f.key] ?? hintFor(f.key) }}
            </p>
          </div>
        }
      </div>

      <app-trade-summary [summary]="summary()" [slippage]="slippage" />

      <button type="submit" class="btn-primary w-full" [disabled]="!valid() || submitting()">
        {{ submitting() ? 'Envoi…' : 'Valider le paper trade' }}
      </button>
      @if (error(); as e) {
        <p class="text-center text-sm text-bear" role="alert" data-submit-error>{{ e }}</p>
      }
    </form>
  `,
})
export class PaperTradeForm {
  readonly initial = input.required<PaperDraft>();
  /** Virtual balance (null = unknown, not checked client-side). */
  readonly available = input<number | null>(null);
  readonly submitting = input(false);
  readonly error = input<string | null>(null);
  readonly submitted = output<PaperDraft>();

  protected readonly uid = `paper-form-${++nextId}-`;
  protected readonly slippage = PAPER_SLIPPAGE;
  protected readonly fields = FIELDS;

  protected readonly text = linkedSignal<DraftText>(() => toText(this.initial()));
  protected readonly entryLabel = computed(() => formatPrice(this.initial().entry));
  readonly draft = computed<PaperDraft>(() => {
    const t = this.text();
    return { stake: parseDecimalInput(t.stake), entry: this.initial().entry, slPct: parseInteger(t.slPct) };
  });
  protected readonly errors = computed(() => validateDraft(this.draft(), this.available()));
  protected readonly valid = computed(() => Object.keys(this.errors()).length === 0);
  protected readonly summary = computed(() => (this.valid() ? tradeSummary(this.draft()) : null));

  protected hintFor(key: DraftField): string {
    if (key === 'stake') {
      const a = this.available();
      return a === null ? 'Entre 0,01 et 100 SOL.' : `Disponible : ${formatSolAmount(a)} SOL (ordres en attente déduits).`;
    }
    return 'Entre 1 et 90 %.';
  }

  protected edit(key: DraftField, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.text.update((t) => ({ ...t, [key]: target.value }));
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.valid() || this.submitting()) return;
    this.submitted.emit(this.draft());
  }
}
