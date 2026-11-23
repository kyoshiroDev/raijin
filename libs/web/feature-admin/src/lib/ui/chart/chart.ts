import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { type MetricUnit } from '@raijin/shared-contracts';
import { RjIcon, RjSkeleton, type RjIconName } from '@raijin/web-ui';
import { type IconNode } from 'lucide';
import { AdminIcons } from '../admin-icons';
import { NO_VALUE, formatMetric } from '../format';
import {
  buildChartConfig,
  categoryTickLimit,
  readChartTheme,
  summarizeChart,
  type RjChartDataset,
  type RjChartTone,
  type RjChartType,
} from './chart-config';
import { RJ_CHART_LOADER, type RjChartInstance } from './chart-loader';

let nextId = 0;

const HEIGHTS = { sm: 'h-48', md: 'h-64 md:h-72', lg: 'h-72 md:h-96' } as const;

/** Pastille de légende par rôle (classes générées par les tokens). */
const SWATCH: Readonly<Record<RjChartTone, string>> = {
  primary: 'bg-thunder',
  comparison: 'bg-info',
  info: 'bg-info',
  safe: 'bg-safe',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-ink-muted',
};

/** Verdicts : toujours icône + mot (BRAND.md), jamais la couleur seule. */
const VERDICT_ICONS: Partial<Record<RjChartTone, RjIconName>> = { safe: 'safe', warn: 'warn', danger: 'danger' };
const VERDICT_TEXT: Partial<Record<RjChartTone, string>> = { safe: 'text-safe', warn: 'text-warn', danger: 'text-danger' };

interface LegendItem {
  readonly label: string;
  readonly tone: RjChartTone;
  readonly dashed: boolean;
  readonly icon: RjIconName | IconNode | null;
  readonly value: string | null;
}

/**
 * Graphique de l'admin (Chart.js 4 chargé à la demande, thémé par les tokens) : `line` (tendances avec période
 * précédente en pointillés), `bar` (verticales ou `[horizontal]="true"` pour un entonnoir), `doughnut`
 * (répartitions, couleurs de verdict via `tones`).
 *
 * Accessibilité : canvas `role="img"` avec un résumé chiffré, légende HTML (forme + texte, icône pour les
 * verdicts), bouton « Voir les données » qui affiche un tableau équivalent. `prefers-reduced-motion` coupe les
 * animations. Lisible à 360 px (moins de graduations, hauteur fixe, infobulle au toucher).
 *
 * ```html
 * <rj-chart type="line" title="Inscriptions" unit="count" [labels]="chart.labels" [datasets]="chart.datasets" />
 * ```
 * Avec une série du contrat : `timeSeriesToChart(series, { current: 'Inscriptions', comparison: '7 j précédents' })`.
 */
@Component({
  selector: 'rj-chart',
  imports: [RjIcon, RjSkeleton],
  template: `
    <figure class="flex min-w-0 flex-col gap-3">
      @if (legend() && legendItems().length > 0) {
        <ul class="flex flex-wrap gap-x-4 gap-y-1.5 text-body-sm text-ink" [attr.aria-label]="'Légende : ' + title()">
          @for (item of legendItems(); track item.label) {
            <li class="inline-flex min-w-0 items-center gap-2">
              @if (item.icon) {
                <rj-icon [name]="item.icon" [size]="16" [class]="verdictText(item.tone)" />
              } @else if (type() === 'line') {
                <span aria-hidden="true" class="inline-flex w-4 items-center gap-0.5">
                  @if (item.dashed) {
                    <span [class]="'h-0.5 w-1.5 rounded-full ' + swatch(item.tone)"></span>
                    <span [class]="'h-0.5 w-1.5 rounded-full ' + swatch(item.tone)"></span>
                  } @else {
                    <span [class]="'h-0.5 w-4 rounded-full ' + swatch(item.tone)"></span>
                  }
                </span>
              } @else {
                <span aria-hidden="true" [class]="'size-2.5 shrink-0 rounded-sm ' + swatch(item.tone)"></span>
              }
              <span class="truncate">{{ item.label }}</span>
              @if (item.value) {
                <span class="tabular text-ink-muted">{{ item.value }}</span>
              }
            </li>
          }
        </ul>
      }
      <div #frame [class]="'relative min-w-0 ' + heightClass()">
        <canvas #canvas role="img" [attr.aria-label]="ariaLabel()" class="block size-full">{{ ariaLabel() }}</canvas>
        @if (state() === 'loading') {
          <rj-skeleton shape="block" class="absolute inset-0" />
        } @else if (state() === 'error') {
          <p class="absolute inset-0 flex items-center justify-center rounded-md border border-dashed border-line p-4 text-center text-body-sm text-ink-muted">
            Le graphique ne s’affiche pas sur cet appareil. Les chiffres restent lisibles dans le tableau.
          </p>
        }
      </div>
      <div class="flex justify-end">
        <button
          type="button"
          class="-mr-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-body-sm font-medium text-info transition-colors duration-150 ease-raijin hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          [attr.aria-expanded]="tableVisible()"
          [attr.aria-controls]="tableId"
          (click)="showTable.set(!showTable())"
        >
          <rj-icon [name]="tableIcon" [size]="16" />
          {{ tableVisible() ? 'Masquer les données' : 'Voir les données' }}
        </button>
      </div>
      <div [id]="tableId" class="min-w-0 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" role="region" tabindex="0" [attr.aria-label]="'Données : ' + title()" [hidden]="!tableVisible()">
        @if (tableVisible()) {
          <table class="w-full border-collapse text-left text-body-sm">
            <caption class="sr-only">{{ title() }}</caption>
            <thead>
              <tr class="border-b border-line">
                <th scope="col" class="px-2 py-2 text-label font-semibold tracking-wide text-ink-muted uppercase">{{ categoryLabel() }}</th>
                @for (dataset of datasets(); track dataset.label) {
                  <th scope="col" class="px-2 py-2 text-right text-label font-semibold tracking-wide text-ink-muted uppercase">{{ dataset.label }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (label of labels(); track $index; let i = $index) {
                <tr class="border-b border-line last:border-b-0">
                  <th scope="row" class="px-2 py-2 font-medium whitespace-nowrap text-ink">{{ label }}</th>
                  @for (dataset of datasets(); track dataset.label) {
                    <td class="tabular px-2 py-2 text-right text-ink">{{ cell(dataset, i) }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
    </figure>
  `,
  host: { class: 'block min-w-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjChart {
  private readonly document = inject(DOCUMENT);
  private readonly loader = inject(RJ_CHART_LOADER);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');
  private chart: RjChartInstance | null = null;
  private chartType: RjChartType | null = null;

  readonly type = input.required<RjChartType>();
  /** Nom du graphique : nom accessible, légende du tableau de données. */
  readonly title = input.required<string>();
  readonly labels = input.required<readonly string[]>();
  readonly datasets = input.required<readonly RjChartDataset[]>();
  readonly unit = input<MetricUnit>('count');
  readonly currency = input('EUR');
  readonly horizontal = input(false);
  readonly height = input<keyof typeof HEIGHTS>('md');
  /** Résumé lu par les lecteurs d'écran ; calculé (bornes, dernière valeur, parts) si vide. */
  readonly summary = input('');
  /** En-tête de la première colonne du tableau de données. */
  readonly categoryLabel = input('Date');
  readonly legend = input(true);

  protected readonly tableId = `rj-chart-table-${nextId++}`;
  protected readonly tableIcon = AdminIcons.table;
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly showTable = signal(false);
  /** En cas d'échec du graphique, le tableau prend sa place. */
  protected readonly tableVisible = computed(() => this.showTable() || this.state() === 'error');
  private readonly themeVersion = signal(0);
  private readonly reducedMotion = signal(false);
  private readonly width = signal<number | undefined>(undefined);
  private readonly tickBucket = computed(() => categoryTickLimit(this.width()));

  protected readonly heightClass = computed(() => HEIGHTS[this.height()]);

  protected readonly ariaLabel = computed(
    () =>
      this.summary() ||
      summarizeChart({
        type: this.type(),
        title: this.title(),
        labels: this.labels(),
        datasets: this.datasets(),
        unit: this.unit(),
        currency: this.currency(),
      }),
  );

  protected readonly legendItems = computed<LegendItem[]>(() => {
    if (this.type() === 'doughnut') {
      const dataset = this.datasets()[0];
      if (!dataset) return [];
      const total = dataset.data.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      return this.labels().map((label, index) => {
        const tone = dataset.tones?.[index] ?? dataset.tone;
        const value = dataset.data[index] ?? null;
        return {
          label,
          tone,
          dashed: false,
          icon: VERDICT_ICONS[tone] ?? null,
          value: total > 0 && value !== null ? formatMetric(value / total, 'ratio') : NO_VALUE,
        };
      });
    }
    return this.datasets().map((dataset) => ({
      label: dataset.label,
      tone: dataset.tone,
      dashed: dataset.tone === 'comparison',
      icon: VERDICT_ICONS[dataset.tone] ?? null,
      value: null,
    }));
  });

  constructor() {
    const view = this.document.defaultView;
    const motion = typeof view?.matchMedia === 'function' ? view.matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.reducedMotion.set(motion?.matches ?? false);
    const onMotion = (event: MediaQueryListEvent) => this.reducedMotion.set(event.matches);
    motion?.addEventListener('change', onMotion);

    // Changement de thème (`data-theme` sur la racine) : les couleurs sont relues.
    const observer =
      typeof MutationObserver === 'function' ? new MutationObserver(() => this.themeVersion.update((v) => v + 1)) : null;
    observer?.observe(this.document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

    let resize: ResizeObserver | null = null;
    afterNextRender(() => {
      const frame = this.frame().nativeElement;
      this.width.set(frame.clientWidth || undefined);
      if (typeof ResizeObserver === 'function') {
        resize = new ResizeObserver((entries) => this.width.set(entries[0]?.contentRect.width || undefined));
        resize.observe(frame);
      }
      this.loader().then(
        (factory) => {
          this.factory = factory;
          this.render();
          this.state.set('ready');
        },
        () => this.state.set('error'),
      );
    });

    // Données, thème, mouvement ou palier de largeur modifiés : mise à jour du graphique existant.
    effect(() => {
      this.type();
      this.labels();
      this.datasets();
      this.unit();
      this.horizontal();
      this.themeVersion();
      this.reducedMotion();
      this.tickBucket();
      untracked(() => this.render());
    });

    inject(DestroyRef).onDestroy(() => {
      motion?.removeEventListener('change', onMotion);
      observer?.disconnect();
      resize?.disconnect();
      this.chart?.destroy();
      this.chart = null;
    });
  }

  private factory: ((canvas: HTMLCanvasElement, config: ReturnType<typeof buildChartConfig>) => RjChartInstance) | null = null;

  private render(): void {
    if (!this.factory) return;
    const config = buildChartConfig(
      {
        type: this.type(),
        labels: this.labels(),
        datasets: this.datasets(),
        unit: this.unit(),
        currency: this.currency(),
        horizontal: this.horizontal(),
        width: this.width(),
      },
      readChartTheme(this.document.documentElement),
      this.reducedMotion(),
    );
    if (this.chart && this.chartType === this.type()) {
      this.chart.data = config.data;
      this.chart.options = config.options;
      this.chart.update(this.reducedMotion() ? 'none' : undefined);
      return;
    }
    this.chart?.destroy();
    try {
      this.chart = this.factory(this.canvas().nativeElement, config);
      this.chartType = this.type();
    } catch {
      this.chart = null;
      this.state.set('error');
    }
  }

  protected swatch(tone: RjChartTone): string {
    return SWATCH[tone];
  }

  protected verdictText(tone: RjChartTone): string {
    return VERDICT_TEXT[tone] ?? 'text-ink-muted';
  }

  protected cell(dataset: RjChartDataset, index: number): string {
    return formatMetric(dataset.data[index] ?? null, this.unit(), { currency: this.currency() });
  }
}
