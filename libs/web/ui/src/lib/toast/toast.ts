import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RjIcon } from '../icon/icon';
import { type RjIconName } from '../icon/icons';
import { RjToastService, type RjToastTone } from './toast.service';

const TONES: Record<RjToastTone, { icon: RjIconName; color: string }> = {
  info: { icon: 'info', color: 'text-info' },
  success: { icon: 'circleCheck', color: 'text-safe' },
  error: { icon: 'circleAlert', color: 'text-danger' },
};

/** Un toast : icône de ton + message + bouton fermer (44 px). */
@Component({
  selector: 'rj-toast',
  imports: [RjIcon],
  template: `
    <rj-icon [name]="tone().icon" [size]="20" [class]="tone().color + ' mt-3'" />
    <p class="min-w-0 flex-1 py-3 text-body-sm text-ink">{{ message() }}</p>
    <button
      type="button"
      class="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 ease-raijin hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      aria-label="Fermer la notification"
      (click)="dismissed.emit()"
    >
      <rj-icon name="close" [size]="16" />
    </button>
  `,
  host: {
    class:
      'pointer-events-auto flex w-full items-start gap-3 rounded-md border border-line bg-surface-raised pl-4 pr-1 shadow-card',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjToastItem {
  readonly message = input.required<string>();
  readonly kind = input<RjToastTone>('info');
  readonly dismissed = output<void>();

  protected readonly tone = computed(() => TONES[this.kind()]);
}

/** Classes de la zone des toasts : au-dessus de la barre d'onglets sur mobile, en bas à droite dès 1024 px. */
export const RJ_TOAST_REGION_CLASSES =
  'pointer-events-none fixed inset-x-0 bottom-tabbar z-50 mx-auto flex max-w-md flex-col gap-2 px-4 lg:bottom-6 lg:left-auto lg:right-6 lg:mx-0 lg:w-96 lg:px-0';

/**
 * Liste des toasts, à placer dans une région `aria-live`. La coquille de l'app garde la région dès le départ et ne
 * charge cette liste qu'au premier toast (docs/ARCHITECTURE.md §10.6, G6) : l'annonce reste fiable.
 */
@Component({
  selector: 'rj-toast-list',
  imports: [RjToastItem],
  template: `
    @for (toast of service.toasts(); track toast.id) {
      <rj-toast
        animate.enter="rj-toast-in"
        [message]="toast.message"
        [kind]="toast.tone"
        (dismissed)="service.dismiss(toast.id)"
      />
    }
  `,
  styles: `
    @keyframes rj-toast-in { from { opacity: 0; transform: translateY(8px); } }
    .rj-toast-in { animation: rj-toast-in 200ms var(--ease-raijin) both; }
  `,
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjToastList {
  protected readonly service = inject(RjToastService);
}

/**
 * Zone des toasts complète (région `aria-live` polie + liste) : les messages sont annoncés sans voler le focus.
 */
@Component({
  selector: 'rj-toast-host',
  imports: [RjToastList],
  template: `
    <div role="status" aria-live="polite" [class]="regionClasses">
      <rj-toast-list />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjToastHost {
  protected readonly regionClasses = RJ_TOAST_REGION_CLASSES;
}
