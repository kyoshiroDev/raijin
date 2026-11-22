import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import type { AnalysisCheck } from '@raijin/shared-contracts';
import { RjIcon } from '@raijin/web-ui';
import { CHECK_STATUS_DISPLAY, formatMetric, safeSourceUrl } from './check-display';
import { ANALYSIS_CHECK_LABELS } from './labels';

let nextId = 0;

/**
 * Un contrôle de l'analyse en accordéon : statut (icône + mot), phrase d'explication, puis au
 * dépli les valeurs chiffrées (compactes, valeur exacte en `title`), les sources (liens externes
 * sûrs uniquement) et « En savoir plus ». Tout texte est rendu par interpolation.
 */
@Component({
  selector: 'rj-check-item',
  imports: [RjIcon],
  template: `
    <h3>
      <button
        type="button"
        [id]="buttonId"
        [attr.aria-expanded]="expanded()"
        [attr.aria-controls]="panelId"
        class="flex min-h-16 w-full items-start gap-3 rounded-md py-3 text-left transition-colors duration-150 ease-raijin hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring md:-mx-2 md:w-[calc(100%+16px)] md:px-2"
        (click)="toggle()"
      >
        <span [class]="'mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-md border ' + display().chip">
          <rj-icon [name]="display().icon" [size]="20" />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex items-start justify-between gap-2">
            <span class="text-body font-semibold text-ink">{{ label() }}</span>
            <span [class]="'shrink-0 pt-0.5 text-body-sm font-semibold ' + display().text" data-status>{{ display().label }}</span>
          </span>
          <span
            class="text-body-sm text-ink-muted"
            [class.line-clamp-2]="!expanded()"
            [attr.title]="expanded() ? null : check().summary"
            >{{ check().summary }}</span
          >
        </span>
        <rj-icon
          name="chevronDown"
          [size]="20"
          class="mt-2 shrink-0 text-ink-muted transition-transform duration-200 ease-raijin"
          [class.rotate-180]="expanded()"
        />
      </button>
    </h3>
    @if (expanded()) {
      <div
        [id]="panelId"
        role="region"
        [attr.aria-labelledby]="buttonId"
        class="flex flex-col gap-3 pb-4 xs:pl-12"
        animate.enter="rj-panel-in"
      >
        @if (metrics().length > 0) {
          <dl class="flex flex-col rounded-md border border-line bg-base px-3">
            @for (metric of metrics(); track metric.key) {
              <div class="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-0">
                <dt class="min-w-0 text-body-sm text-ink-muted">{{ metric.label }}</dt>
                <dd
                  class="shrink-0 text-right text-data"
                  [class.tabular]="metric.formatted.mono"
                  [class.text-ink]="!metric.formatted.missing"
                  [class.text-ink-muted]="metric.formatted.missing"
                  [attr.title]="metric.formatted.exact"
                >
                  <span aria-hidden="true">{{ metric.formatted.text }}</span>
                  <span class="sr-only">{{ metric.formatted.exact }}</span>
                </dd>
              </div>
            }
          </dl>
        }
        @if (check().id === 'rugcheck') {
          <p class="flex items-start gap-1.5 text-body-sm text-ink-muted" data-external-note>
            <rj-icon name="info" [size]="16" class="mt-0.5 shrink-0" />
            <span>Avis d’un service externe, repris tel quel : Raijin ne l’a pas vérifié lui-même.</span>
          </p>
        }
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p class="flex flex-wrap items-center gap-x-3 text-body-sm text-ink-muted">
            <span>{{ check().sources.length > 1 ? 'Sources' : 'Source' }} :</span>
            @for (source of sources(); track source.id) {
              @if (source.href; as href) {
                <a
                  [href]="href"
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  class="inline-flex min-h-11 items-center gap-1 rounded-sm font-medium text-info underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >{{ source.name }}<rj-icon name="external" [size]="16" /><span class="sr-only"> (nouvel onglet)</span></a
                >
              } @else {
                <span class="inline-flex min-h-11 items-center text-ink">{{ source.name }}</span>
              }
            }
          </p>
          <button
            type="button"
            class="-mr-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-body-sm font-semibold text-ink transition-colors duration-150 ease-raijin hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            [attr.aria-label]="'En savoir plus : ' + label()"
            (click)="learnMore.emit()"
          >
            <rj-icon name="help" [size]="16" class="text-info" />En savoir plus
          </button>
        </div>
      </div>
    }
  `,
  styles: `
    @keyframes rj-panel-in { from { opacity: 0; transform: translateY(-4px); } }
    .rj-panel-in { animation: rj-panel-in 180ms var(--ease-raijin) both; }
  `,
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjCheckItem {
  readonly check = input.required<AnalysisCheck>();
  readonly expanded = model(false);
  readonly learnMore = output<void>();

  protected readonly buttonId = `rj-check-${nextId}`;
  protected readonly panelId = `rj-check-panel-${nextId++}`;
  protected readonly label = computed(() => {
    const id = this.check().id;
    return Object.hasOwn(ANALYSIS_CHECK_LABELS, id) ? ANALYSIS_CHECK_LABELS[id] : 'Contrôle';
  });
  protected readonly display = computed(() => CHECK_STATUS_DISPLAY[this.check().status]);
  protected readonly metrics = computed(() =>
    this.check().metrics.map((metric) => ({ key: metric.key, label: metric.label, formatted: formatMetric(metric) })),
  );
  protected readonly sources = computed(() =>
    this.check().sources.map((source) => ({ id: source.id, name: source.name, href: safeSourceUrl(source.url) })),
  );

  protected toggle(): void {
    this.expanded.update((value) => !value);
  }
}
