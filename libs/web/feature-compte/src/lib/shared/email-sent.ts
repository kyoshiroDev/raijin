import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RjButton, RjIcon } from '@raijin/web-ui';
import { createCooldown } from './cooldown';

/**
 * Confirmation neutre « e-mail envoyé » (inscription, lien magique, mot de passe oublié) :
 * ne dit jamais si l'adresse a un compte. Bouton « Renvoyer » limité à un envoi par minute.
 */
@Component({
  selector: 'rj-email-sent',
  imports: [RjButton, RjIcon],
  template: `
    <div class="flex items-start gap-4" role="status">
      <span class="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-thunder-soft text-thunder-ink">
        <rj-icon name="mailCheck" [size]="24" />
      </span>
      <div class="flex min-w-0 flex-col gap-2 text-body text-ink-muted">
        <p>
          Si cette adresse peut être utilisée, un e&#8209;mail part vers
          <strong class="font-semibold wrap-anywhere text-ink">{{ email() }}</strong>.
        </p>
        <p>{{ detail() }}</p>
      </div>
    </div>
    <ul class="flex flex-col gap-1 rounded-md bg-surface-raised p-3 text-body-sm text-ink-muted">
      <li>Rien reçu&nbsp;? Regarde dans les courriers indésirables.</li>
      <li>Vérifie l’orthographe de l’adresse ci&#8209;dessus.</li>
    </ul>
    <button type="button" rjButton="secondary" icon="retry" [block]="true" [loading]="sending()" [disabled]="cooldown.active()" (click)="onResend()">
      {{ resendLabel() }}
    </button>
  `,
  host: { class: 'flex flex-col gap-4' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjEmailSent {
  readonly email = input.required<string>();
  /** Validité du lien et suite du parcours. */
  readonly detail = input.required<string>();
  readonly sending = input(false);
  readonly resend = output<void>();

  protected readonly cooldown = createCooldown(60);
  protected readonly resendLabel = computed(() => {
    const seconds = this.cooldown.remaining();
    return seconds > 0 ? `Renvoyer dans ${seconds} s` : 'Renvoyer l’e-mail';
  });

  constructor() {
    // Un e-mail vient de partir : on évite le double envoi immédiat.
    this.cooldown.start();
  }

  protected onResend(): void {
    this.cooldown.start();
    this.resend.emit();
  }
}
