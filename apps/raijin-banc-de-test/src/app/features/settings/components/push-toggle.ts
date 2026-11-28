import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { Feedback, PushStatus } from '../settings-store';

const DESCRIPTION: Record<PushStatus, string> = {
  on: 'Activées sur cet appareil.',
  off: 'Alertes push quand un jeune token passe le profil « Jeune calme ».',
  denied: 'Refusées dans les réglages de l’appareil.',
  unsupported: 'Ce navigateur ne gère pas les notifications push.',
  'ios-install': 'Ajoute d’abord Banc test à l’écran d’accueil (voir ci-dessus).',
};

/** « Notifications » switch. The parent requests the permission on `toggled` (a tap), never before. */
@Component({
  selector: 'app-push-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-3' },
  template: `
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <p id="push-toggle-label" class="font-semibold">Notifications</p>
        <p id="push-toggle-desc" class="text-sm text-muted">{{ description() }}</p>
      </div>
      <button
        type="button"
        role="switch"
        class="group inline-flex h-11 w-16 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-50"
        aria-labelledby="push-toggle-label"
        aria-describedby="push-toggle-desc"
        [attr.aria-checked]="on()"
        [attr.aria-busy]="busy()"
        [disabled]="disabled()"
        (click)="toggled.emit()"
      >
        <span
          aria-hidden="true"
          class="relative block h-8 w-14 rounded-full border transition-colors"
          [class.bg-fg]="on()"
          [class.border-fg]="on()"
          [class.bg-surface-2]="!on()"
          [class.border-line]="!on()"
        >
          <span
            class="absolute top-1/2 left-0.5 block size-6 -translate-y-1/2 rounded-full transition-transform"
            [class.translate-x-6]="on()"
            [class.bg-base]="on()"
            [class.bg-muted]="!on()"
          ></span>
        </span>
      </button>
    </div>

    @if (status() === 'denied') {
      <p class="rounded-xl bg-surface-2 p-3 text-sm text-muted" data-testid="push-denied">
        Pour les réactiver sur iPhone : <span class="text-fg">Réglages iOS → Banc test → Notifications</span>, puis
        « Autoriser les notifications ». Sur un autre navigateur : autorise les notifications dans les réglages du site.
      </p>
    }
    @if (busy()) {
      <p class="text-sm text-muted" role="status">Un instant…</p>
    } @else if (message(); as m) {
      <p class="text-sm" [class.text-bear]="m.kind === 'error'" [class.text-bull]="m.kind === 'ok'" role="alert">{{ m.text }}</p>
    }
  `,
})
export class PushToggle {
  readonly status = input.required<PushStatus>();
  readonly busy = input(false);
  readonly message = input<Feedback | null>(null);
  readonly toggled = output();

  protected readonly on = computed(() => this.status() === 'on');
  protected readonly description = computed(() => DESCRIPTION[this.status()]);
  protected readonly disabled = computed(() => this.busy() || (this.status() !== 'on' && this.status() !== 'off'));
}
