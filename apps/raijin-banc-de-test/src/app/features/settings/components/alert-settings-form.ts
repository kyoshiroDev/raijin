import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from '@angular/core';
import { preferencesOf, quietHoursLabel, validateAlertPreferences, type AlertPreferences, type AlertSettings } from '../alert-settings';
import type { Feedback } from '../settings-store';
import { AlertCapsField, type CapChange } from './alert-caps-field';
import { PaperSettingsField } from './paper-settings-field';
import { StakeField } from './stake-field';

type HourField = 'quiet_start' | 'quiet_end';

/**
 * Alert preferences. The profile is fixed (« Jeune calme », shown as information); edits a local draft of the rest;
 * « Enregistrer » emits it only when valid.
 */
@Component({
  selector: 'app-alert-settings-form',
  imports: [AlertCapsField, PaperSettingsField, StakeField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <form class="card space-y-5" novalidate (submit)="submit($event)">
      <app-stake-field [stake]="settings().stake_sol" [error]="errors().stake_sol" (stakeChange)="patch({ stake_sol: $event })" />

      <section class="space-y-1 rounded-xl border border-line bg-surface-2 px-3 py-2.5" aria-labelledby="alert-profile-title" data-alert-profile>
        <h3 id="alert-profile-title" class="text-sm font-semibold">Profil d’alertes : Jeune calme</h3>
        <p class="text-xs text-muted">
          Paire de moins de 24 h sur PumpSwap, variation 1 h entre 0 et 100 %, ratio achats/ventes 1 h entre 0,8 et 1,3,
          liquidité ≥ 30 k$, sécurité vérifiée (mint/freeze désactivées, top 10 &lt; 25 %, pas d’insiders, LP verrouillée),
          aller-retour &lt; 5 %, pas de Structure cassée. Objectif ×2, stop −30 %. C’est le seul profil : il n’y a rien à choisir.
        </p>
      </section>

      <fieldset class="space-y-2">
        <legend class="text-sm font-semibold">Heures calmes (heure de Paris)</legend>
        <div class="grid grid-cols-2 gap-3">
          <label class="space-y-1 text-xs text-muted">
            Début
            <select class="field" [value]="draft().quiet_start" (change)="setHour('quiet_start', $event)">
              @for (h of hours; track h) { <option [value]="h" [selected]="h === draft().quiet_start">{{ h }} h</option> }
            </select>
          </label>
          <label class="space-y-1 text-xs text-muted">
            Fin
            <select class="field" [value]="draft().quiet_end" (change)="setHour('quiet_end', $event)">
              @for (h of hours; track h) { <option [value]="h" [selected]="h === draft().quiet_end">{{ h }} h</option> }
            </select>
          </label>
        </div>
        <p class="text-xs text-muted">Aucune alerte pendant : {{ quietLabel() }}. Même heure de début et de fin = pas d’heures calmes.</p>
        @if (errors().quiet_start; as e) { <p class="text-sm text-bear">{{ e }}</p> }
        @if (errors().quiet_end; as e) { <p class="text-sm text-bear">{{ e }}</p> }
      </fieldset>

      <app-alert-caps-field
        [perHour]="draft().max_per_hour"
        [perDay]="draft().max_per_day"
        [perHourError]="errors().max_per_hour"
        [perDayError]="errors().max_per_day"
        (capChange)="setCap($event)"
      />

      <app-paper-settings-field
        class="border-t border-line pt-4"
        [slPct]="settings().paper_sl_pct"
        [autoPaper]="draft().auto_paper"
        [stake]="draft().stake_sol"
        [slError]="errors().paper_sl_pct"
        (slPctChange)="patch({ paper_sl_pct: $event })"
        (autoPaperChange)="patch({ auto_paper: $event })"
      />

      <button type="submit" class="btn-primary w-full" [disabled]="saving() || !valid()">
        {{ saving() ? 'Enregistrement…' : 'Enregistrer' }}
      </button>
      @if (message(); as m) {
        <p class="text-center text-sm" [class.text-bull]="m.kind === 'ok'" [class.text-bear]="m.kind === 'error'" role="status">{{ m.text }}</p>
      }
    </form>
  `,
})
export class AlertSettingsForm {
  readonly settings = input.required<AlertSettings>();
  readonly saving = input(false);
  readonly message = input<Feedback | null>(null);
  readonly save = output<AlertPreferences>();

  protected readonly hours = Array.from({ length: 24 }, (_, h) => h);

  /** Local draft, reset whenever the stored settings change. */
  protected readonly draft = linkedSignal(() => preferencesOf(this.settings()));
  protected readonly errors = computed(() => validateAlertPreferences(this.draft()));
  protected readonly valid = computed(() => Object.keys(this.errors()).length === 0);
  protected readonly quietLabel = computed(() => quietHoursLabel(this.draft().quiet_start, this.draft().quiet_end));

  protected setHour(field: HourField, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    // Empty / non-numeric input becomes NaN, which validation reports (never sent).
    const value = target.value.trim() === '' ? Number.NaN : Number(target.value);
    this.draft.update((d) => ({ ...d, [field]: value }));
  }

  protected setCap({ field, value }: CapChange): void {
    this.draft.update((d) => ({ ...d, [field]: value }));
  }

  protected patch(change: Partial<AlertPreferences>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.valid() || this.saving()) return;
    this.save.emit(this.draft());
  }
}
