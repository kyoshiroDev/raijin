import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  GOOGLE_SERVICE_ERROR_MESSAGES,
  GOOGLE_SERVICE_LABELS,
  NOT_CONNECTED_LABEL,
  type GoogleService,
  type GoogleServiceState,
} from '@raijin/shared-contracts';
import { RjIcon } from '@raijin/web-ui';
import { AdminIcons } from './admin-icons';
import { formatLongDay, formatTime } from './format';

/**
 * État d'un service Google (GA4, Search Console) lu par l'admin.
 * - `variant="block"` (défaut) : à la place des données quand le service n'est pas connecté ou en erreur
 *   (« Non connecté » + marche à suivre) ; rien si le service est connecté.
 * - `variant="inline"` : pastille discrète à côté d'un titre : « Données simulées », « Mis à jour à 14:02 »,
 *   « Non connecté » ou « Erreur ».
 *
 * `@if (report.service.status !== 'connected') { <rj-service-state service="ga4" [state]="report.service" /> }`
 */
@Component({
  selector: 'rj-service-state',
  imports: [RjIcon],
  template: `
    @if (variant() === 'block') {
      @switch (state().status) {
        @case ('not_connected') {
          <div class="flex flex-col items-start gap-3 rounded-lg border border-dashed border-line-strong bg-surface p-4 md:flex-row md:gap-4 md:p-6">
            <span class="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-surface-raised text-ink-muted">
              <rj-icon [name]="icons.notConnected" [size]="24" />
            </span>
            <div class="flex min-w-0 flex-col gap-1">
              <p class="font-display text-h3 text-ink">{{ label() }}&nbsp;: {{ notConnected }}</p>
              <p class="text-body text-ink-muted">
                Les écrans qui en dépendent restent vides tant que le compte de service n’est pas relié. La marche à suivre
                est dans <span class="font-mono text-data text-ink">docs/DEPLOY.md</span>, section Google.
              </p>
            </div>
          </div>
        }
        @case ('error') {
          <div role="alert" class="flex flex-col items-start gap-3 rounded-lg border border-warn bg-surface p-4 md:flex-row md:gap-4 md:p-6">
            <span class="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-surface-raised text-warn">
              <rj-icon name="warn" [size]="24" />
            </span>
            <div class="flex min-w-0 flex-col gap-1">
              <p class="font-display text-h3 text-ink">{{ label() }}&nbsp;: erreur</p>
              <p class="text-body text-ink-muted">{{ errorMessage() }}</p>
            </div>
          </div>
        }
      }
    } @else {
      <span [class]="badgeClasses()">
        <rj-icon [name]="badge().icon" [size]="16" />
        <span>{{ badge().text }}</span>
      </span>
    }
  `,
  host: { class: 'block min-w-0', '[class.contents]': "variant() === 'inline'" },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjServiceState {
  readonly service = input.required<GoogleService>();
  readonly state = input.required<GoogleServiceState>();
  readonly variant = input<'block' | 'inline'>('block');

  protected readonly icons = AdminIcons;
  protected readonly notConnected = NOT_CONNECTED_LABEL;
  protected readonly label = computed(() => GOOGLE_SERVICE_LABELS[this.service()]);
  protected readonly errorMessage = computed(() => {
    const state = this.state();
    return state.status === 'error' ? GOOGLE_SERVICE_ERROR_MESSAGES[state.error] : '';
  });

  protected readonly badge = computed(() => {
    const state = this.state();
    switch (state.status) {
      case 'connected':
        return state.simulated
          ? { icon: AdminIcons.simulated, text: 'Données simulées', tone: 'info' as const }
          : { icon: 'circleCheck' as const, text: `Mis à jour à ${formatTime(state.fetchedAt)}`, tone: 'muted' as const };
      case 'not_connected':
        return { icon: AdminIcons.notConnected, text: NOT_CONNECTED_LABEL, tone: 'muted' as const };
      case 'error':
        return { icon: 'warn' as const, text: 'Erreur Google', tone: 'warn' as const };
    }
  });

  protected readonly badgeClasses = computed(() => {
    const tone = this.badge().tone;
    const color = tone === 'info' ? 'border-info text-info' : tone === 'warn' ? 'border-warn text-warn' : 'border-line-strong text-ink-muted';
    return `inline-flex min-h-7 items-center gap-1.5 rounded-sm border px-2 text-label font-semibold ${color}`;
  });
}

/**
 * Décalage des données Search Console (2 à 3 jours) : « Données arrêtées au 19 novembre 2026 ».
 * `<rj-data-lag-notice [dataThrough]="seo.dataThrough" [lagDays]="seo.lagDays" />`
 */
@Component({
  selector: 'rj-data-lag-notice',
  imports: [RjIcon],
  template: `
    <rj-icon name="info" [size]="20" class="mt-0.5 text-info" />
    <p class="min-w-0 flex-1 text-body-sm text-ink">
      @if (dataThrough(); as through) {
        Données arrêtées au <span class="font-semibold">{{ day(through) }}</span>.
      } @else {
        Aucune donnée disponible pour l’instant.
      }
      <span class="text-ink-muted">{{ source() }} publie ses chiffres avec {{ lagDays() }} jours de décalage environ.</span>
    </p>
  `,
  host: { role: 'note', class: 'flex items-start gap-3 rounded-md border border-line-strong bg-surface-raised p-3' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjDataLagNotice {
  readonly dataThrough = input<string | null>(null);
  readonly lagDays = input(3);
  readonly source = input('Google Search Console');
  protected readonly day = formatLongDay;
}
