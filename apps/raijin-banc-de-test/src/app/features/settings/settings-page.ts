import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthStore } from '../../core/auth/auth-store';
import { PageHeader } from '../../shared/ui/page-header';
import { AlertSettingsForm } from './components/alert-settings-form';
import { IosInstallGuide } from './components/ios-install-guide';
import { PushToggle } from './components/push-toggle';
import { TestPushButton } from './components/test-push-button';
import { MSG, SettingsStore } from './settings-store';
import { Icon } from '../../shared/ui/icon';

@Component({
  selector: 'app-settings-page',
  imports: [AlertSettingsForm, Icon, IosInstallGuide, PageHeader, PushToggle, RouterLink, TestPushButton],
  providers: [SettingsStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header>
      <h1 class="text-xl font-black tracking-tight">Réglages</h1>
    </app-page-header>

    <main class="mx-auto max-w-lg space-y-6 px-safe pt-4">
      <section aria-labelledby="settings-account" class="space-y-2">
        <h2 id="settings-account" class="text-xs font-semibold tracking-wide text-muted uppercase">Compte</h2>
        <div class="card divide-y divide-line p-0">
          @if (auth.email(); as email) {
            <p class="truncate px-4 py-3 text-sm text-muted">Connecté : <span class="text-fg">{{ email }}</span></p>
          }
          <a routerLink="/account" class="flex min-h-12 items-center justify-between gap-3 px-4 text-sm font-semibold hover:bg-surface-2">
            Mon compte et session
            <app-icon name="chevron-right" class="size-4 text-muted" />
          </a>
          <button
            type="button"
            class="flex min-h-12 w-full items-center px-4 text-left text-sm font-semibold text-bear hover:bg-surface-2 disabled:opacity-50"
            [disabled]="signingOut()"
            (click)="signOut()"
          >
            {{ signingOut() ? 'Déconnexion…' : 'Se déconnecter' }}
          </button>
        </div>
      </section>

      <section aria-labelledby="settings-notifications" class="space-y-3" data-section="notifications">
        <h2 id="settings-notifications" class="text-xs font-semibold tracking-wide text-muted uppercase">Notifications</h2>
        @if (auth.mode() === 'shadow') {
          <p class="card text-sm text-warn" role="note" data-shadow-mode>{{ shadowMessage }}</p>
        }
        @if (store.status() === 'ios-install') {
          <app-ios-install-guide />
        }
        <app-push-toggle
          [status]="store.status()"
          [busy]="store.pushBusy()"
          [message]="store.pushMessage()"
          (toggled)="store.toggle()"
        />
        <app-test-push-button
          [state]="store.testState()"
          [sent]="store.testSent()"
          [disabled]="!store.canSendTest()"
          (send)="store.sendTest()"
        />
      </section>

      <section aria-labelledby="settings-alerts" class="space-y-2" data-section="alerts">
        <h2 id="settings-alerts" class="text-xs font-semibold tracking-wide text-muted uppercase">Mise et alertes</h2>
        @if (store.loadError(); as e) {
          <p class="card text-sm text-bear" role="alert">{{ e }}</p>
        } @else if (store.loaded()) {
          <app-alert-settings-form
            [settings]="store.settings()"
            [saving]="store.saving()"
            [message]="store.saveMessage()"
            (save)="store.savePreferences($event)"
          />
        } @else {
          <p class="card text-sm text-muted" role="status">Chargement des réglages…</p>
        }
      </section>

      <p class="text-center text-label text-muted">Raijin-banc-de-test est un outil de test privé, pas un conseil en investissement.</p>
    </main>
  `,
})
export class SettingsPage implements OnInit {
  protected readonly auth = inject(AuthStore);
  protected readonly shadowMessage = MSG.shadow;
  protected readonly store = inject(SettingsStore);
  private readonly router = inject(Router);
  readonly signingOut = signal(false);

  ngOnInit(): void {
    void this.store.load();
  }

  async signOut(): Promise<void> {
    if (this.signingOut()) return;
    this.signingOut.set(true);
    try {
      await this.auth.signOut();
    } finally {
      this.signingOut.set(false);
      await this.router.navigateByUrl('/login');
    }
  }
}
