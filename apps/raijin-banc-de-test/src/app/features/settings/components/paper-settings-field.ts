import { ChangeDetectionStrategy, Component, input, linkedSignal, output } from '@angular/core';
import { SL_PCT_LIMITS, formatSolAmount } from '@raijin/bench-web-logic';

/**
 * « Paper trading » section of the settings form (SIMULATION ONLY): fixed strategy « tout à ×2 », default stop and
 * auto-paper.
 */
@Component({
  selector: 'app-paper-settings-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-4', 'data-paper-settings': '' },
  template: `
    <div>
      <h3 class="text-sm font-bold">Paper trading</h3>
      <p class="text-xs text-muted">Simulation — aucun argent réel. Mise utilisée : {{ sol(stake()) }} SOL (« Ma mise habituelle »).</p>
    </div>

    <p class="text-sm" data-paper-strategy>
      <span class="font-semibold">Stratégie : tout à ×2.</span>
      <span class="block text-xs text-muted">Toute la position est vendue à ×2 ou au stop. Entrée au prix du marché.</span>
    </p>

    <div class="space-y-1">
      <label for="paper-sl-pct" class="text-sm font-semibold">Stop par défaut (% sous l’entrée)</label>
      <input
        id="paper-sl-pct"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        class="field tabular-nums slashed-zero"
        [value]="slText()"
        [attr.aria-invalid]="!!slError()"
        aria-describedby="paper-sl-pct-hint"
        (input)="onSlInput($event)"
      />
      <p id="paper-sl-pct-hint" class="text-xs text-muted">Entier entre {{ limits.min }} et {{ limits.max }} %. Pré-rempli dans la fiche paper trade.</p>
      @if (slError(); as e) { <p class="text-sm text-bear" role="alert">{{ e }}</p> }
    </div>

    <div class="flex min-h-11 items-start justify-between gap-3" data-auto-paper>
      <label for="alert-auto-paper" class="min-w-0 text-sm">
        <span class="block font-semibold">Auto-paper</span>
        <span id="alert-auto-paper-desc" class="block text-xs text-muted">
          Chaque alerte envoyée ouvre automatiquement un paper trade tout à ×2 avec mon stop par défaut. Ouvre aussi les
          trois portefeuilles de test (Calme SL −30 %, Calme SL −40 %, Frénésie SL −30 % en témoin) pour chaque token qui
          remplit le profil, indépendamment des alertes. Simulation, aucun argent réel.
        </span>
      </label>
      <input
        id="alert-auto-paper"
        type="checkbox"
        role="switch"
        class="mt-0.5 size-5 shrink-0 accent-fg"
        aria-describedby="alert-auto-paper-desc"
        [checked]="autoPaper()"
        [attr.aria-checked]="autoPaper()"
        (change)="onToggle($event)"
      />
    </div>
  `,
})
export class PaperSettingsField {
  readonly slPct = input.required<number>();
  readonly autoPaper = input.required<boolean>();
  readonly stake = input.required<number>();
  readonly slError = input<string | undefined>(undefined);
  /** Parsed integer, NaN when malformed (validation reports it, never sent). */
  readonly slPctChange = output<number>();
  readonly autoPaperChange = output<boolean>();

  protected readonly limits = SL_PCT_LIMITS;
  protected readonly sol = formatSolAmount;
  protected readonly slText = linkedSignal(() => (Number.isFinite(this.slPct()) ? String(this.slPct()) : ''));

  protected onSlInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.slText.set(target.value);
    this.slPctChange.emit(/^\s*\d+\s*$/.test(target.value) ? Number(target.value) : Number.NaN);
  }

  protected onToggle(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.autoPaperChange.emit(target.checked);
  }
}
