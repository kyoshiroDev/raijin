import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RjIcon, type RjIconName } from '@raijin/web-ui';

export type RjAdminAlertTone = 'danger' | 'warn' | 'info' | 'success';

const ICONS: Record<RjAdminAlertTone, RjIconName> = { danger: 'circleAlert', warn: 'warn', info: 'info', success: 'circleCheck' };
const TONES: Record<RjAdminAlertTone, string> = {
  danger: 'border-danger [&>rj-icon]:text-danger',
  warn: 'border-warn [&>rj-icon]:text-warn',
  info: 'border-line-strong [&>rj-icon]:text-info',
  success: 'border-safe [&>rj-icon]:text-safe',
};

/**
 * Message d'un écran admin (erreur, avertissement, information) : icône + texte, jamais la couleur seule.
 * `danger` est annoncé tout de suite (`role="alert"`), les autres poliment (`role="status"`).
 * `<rj-admin-alert tone="warn">Il te reste 2 codes de secours.</rj-admin-alert>`
 */
@Component({
  selector: 'rj-admin-alert',
  imports: [RjIcon],
  template: `
    <rj-icon [name]="icon()" [size]="20" class="mt-0.5" />
    <div class="min-w-0 flex-1 text-body text-ink"><ng-content /></div>
  `,
  host: { '[attr.role]': "tone() === 'danger' ? 'alert' : 'status'", '[class]': 'classes()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAdminAlert {
  readonly tone = input<RjAdminAlertTone>('danger');
  protected readonly icon = computed(() => ICONS[this.tone()]);
  protected readonly classes = computed(() => `flex items-start gap-3 rounded-md border bg-surface-raised p-3 ${TONES[this.tone()]}`);
}
