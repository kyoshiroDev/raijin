import { ChangeDetectionStrategy, Component, ElementRef, Injector, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ADMIN_PATHS, AdminSessionStore } from '@raijin/web-data-access';
import { RjButton, RjCheckbox } from '@raijin/web-ui';
import { RjAdminAlert } from '../ui/alert';
import { focusStepTitle } from './focus';
import { RjRecoveryCodesList } from './recovery-codes-list';

/**
 * Codes de secours, juste après l'activation : montrés **une seule fois** (gardés en mémoire, oubliés en
 * quittant l'écran ; un rechargement ne les remontre jamais). L'accès à l'admin demande de confirmer qu'ils
 * sont rangés.
 */
@Component({
  selector: 'rj-admin-recovery-codes-page',
  imports: [RjButton, RjCheckbox, RjAdminAlert, RjRecoveryCodesList],
  template: `
    <header class="flex flex-col gap-2">
      <p class="text-label font-semibold tracking-wide text-thunder-ink uppercase">Espace admin · étape 2 sur 2</p>
      <h1 class="font-display text-h2 text-ink">Range tes codes de secours</h1>
      <p class="text-body text-ink-muted">
        Si tu perds ton téléphone, un de ces codes remplace le code de l’application. Chacun ne sert qu’une fois.
      </p>
    </header>

    @if (codes; as codes) {
      <rj-admin-alert tone="warn">Ces codes ne seront plus jamais affichés. Copie-les ou télécharge le fichier maintenant.</rj-admin-alert>
      <rj-recovery-codes-list [codes]="codes" />
      <rj-checkbox [(checked)]="saved">J’ai rangé mes codes en lieu sûr</rj-checkbox>
      <button type="button" rjButton="primary" size="lg" [block]="true" iconEnd="arrowRight" [disabled]="!saved()" (click)="continue()">
        Ouvrir l’espace admin
      </button>
    } @else {
      <rj-admin-alert tone="info">Les codes de secours ont déjà été affichés. Tu peux en générer de nouveaux depuis « Double authentification ».</rj-admin-alert>
      <button type="button" rjButton="primary" size="lg" [block]="true" iconEnd="arrowRight" (click)="continue()">Ouvrir l’espace admin</button>
    }
  `,
  host: { class: 'flex flex-col gap-6' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminRecoveryCodesPage {
  private readonly router = inject(Router);
  protected readonly codes = inject(AdminSessionStore).takePendingRecoveryCodes();
  protected readonly saved = signal(false);

  constructor() {
    // Arrivée depuis le formulaire d'activation (souvent défilé en bas) : titre visible et lu.
    focusStepTitle(inject<ElementRef<HTMLElement>>(ElementRef).nativeElement, inject(Injector));
  }

  protected continue(): void {
    void this.router.navigateByUrl(ADMIN_PATHS.root);
  }
}
