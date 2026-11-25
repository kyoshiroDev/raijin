import type { ChartConfiguration, ChartDataset, ScaleOptionsByType, TooltipItem } from 'chart.js';
import { type MetricUnit, type TimeSeries } from '@raijin/shared-contracts';
import { NO_VALUE, formatDay, formatMetric } from '../format';

/** Types de graphiques de l'admin (docs/ARCHITECTURE.md §14.9). */
export type RjChartType = 'line' | 'bar' | 'doughnut';

/**
 * Rôle d'une série ou d'une part, traduit en couleur de token : `primary` = thunder (série principale),
 * `comparison` = info (période précédente, en pointillés), `safe | warn | danger` = verdicts, `info`, `muted`.
 */
export type RjChartTone = 'primary' | 'comparison' | 'safe' | 'warn' | 'danger' | 'info' | 'muted';

export interface RjChartDataset {
  readonly label: string;
  /** Une valeur par libellé ; `null` = trou (jamais un 0 inventé). */
  readonly data: readonly (number | null)[];
  readonly tone: RjChartTone;
  /** Couleur par point (barres et anneau des répartitions, ex. verdicts) ; sinon `tone` partout. */
  readonly tones?: readonly RjChartTone[];
}

/** Couleurs et polices lues dans les variables CSS des tokens (aucune valeur en dur). */
export interface RjChartTheme {
  readonly thunder: string;
  readonly thunderSoft: string;
  readonly info: string;
  readonly safe: string;
  readonly warn: string;
  readonly danger: string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly line: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly fontSans: string;
  readonly fontMono: string;
  /** Taille du texte `label` (px), utilisée pour les graduations. */
  readonly labelSize: number;
  /** Taille du texte `body-sm` (px), utilisée pour les infobulles. */
  readonly bodySmSize: number;
}

const VAR_NAMES: Readonly<Record<Exclude<keyof RjChartTheme, 'labelSize' | 'bodySmSize'>, string>> = {
  thunder: '--color-thunder',
  thunderSoft: '--color-thunder-soft',
  info: '--color-info',
  safe: '--color-safe',
  warn: '--color-warn',
  danger: '--color-danger',
  ink: '--color-ink',
  inkMuted: '--color-ink-muted',
  line: '--color-line',
  surface: '--color-surface',
  surfaceRaised: '--color-surface-raised',
  fontSans: '--font-sans',
  fontMono: '--font-mono',
};

/** Lit le thème courant (`getComputedStyle` de l'élément racine) : à relire au changement de thème. */
export function readChartTheme(element: Element): RjChartTheme {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const read = (name: string) => style?.getPropertyValue(name).trim() ?? '';
  const entries = Object.entries(VAR_NAMES).map(([key, name]) => [key, read(name)]);
  return {
    ...(Object.fromEntries(entries) as Omit<RjChartTheme, 'labelSize' | 'bodySmSize'>),
    labelSize: Number.parseFloat(read('--text-label')) || 12,
    bodySmSize: Number.parseFloat(read('--text-body-sm')) || 13,
  };
}

export function toneColor(theme: RjChartTheme, tone: RjChartTone): string {
  switch (tone) {
    case 'primary':
      return theme.thunder;
    case 'comparison':
    case 'info':
      return theme.info;
    case 'safe':
      return theme.safe;
    case 'warn':
      return theme.warn;
    case 'danger':
      return theme.danger;
    case 'muted':
      return theme.inkMuted;
  }
}

export interface RjChartInput {
  readonly type: RjChartType;
  readonly labels: readonly string[];
  readonly datasets: readonly RjChartDataset[];
  readonly unit: MetricUnit;
  readonly currency?: string;
  /** Barres horizontales (entonnoir, classements). */
  readonly horizontal?: boolean;
  /** Largeur du graphique (px) : sous 480 px, moins de graduations (lisible à 360 px). */
  readonly width?: number;
}

/** Nombre de graduations de l'axe des catégories selon la largeur disponible. */
export function categoryTickLimit(width: number | undefined): number {
  if (width === undefined) return 6;
  if (width < 400) return 4;
  if (width < 640) return 6;
  return 10;
}

/**
 * Libellé de catégorie d'un graphique à barres horizontales découpé en lignes d'au plus `maxChars` caractères
 * (coupure aux espaces, puis en morceaux pour un mot trop long) : Chart.js ne renvoie pas à la ligne et
 * rognerait le libellé au bord du canevas à 320 px (« irect ou inconnu) »). Aucun caractère n'est perdu.
 */
export function wrapCategoryLabel(label: string, maxChars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const chunks = word.match(new RegExp(`.{1,${maxChars}}`, 'gu')) ?? [word];
    for (const chunk of chunks) {
      if (current && current.length + 1 + chunk.length <= maxChars) current += ` ${chunk}`;
      else {
        if (current) lines.push(current);
        current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [label];
}

/** Longueur de ligne des libellés de barres horizontales selon la largeur (≈ 40 % du canevas en police mono). */
export function horizontalLabelChars(width: number | undefined): number {
  if (width === undefined || width < 400) return 12;
  if (width < 640) return 18;
  return 28;
}

/** Configuration Chart.js complète, thémée par les tokens. Pure : testée sans canvas. */
export function buildChartConfig(input: RjChartInput, theme: RjChartTheme, reducedMotion: boolean): ChartConfiguration {
  const format = (value: number | null) => formatMetric(value, input.unit, { currency: input.currency });
  const formatAxis = (value: number | string) =>
    typeof value === 'number' ? formatMetric(value, input.unit, { currency: input.currency, compact: true }) : value;
  const tickFont = { family: theme.fontMono, size: theme.labelSize };

  const tooltip = {
    backgroundColor: theme.surfaceRaised,
    borderColor: theme.line,
    borderWidth: 1,
    titleColor: theme.ink,
    bodyColor: theme.ink,
    titleFont: { family: theme.fontSans, size: theme.bodySmSize, weight: 600 as const },
    bodyFont: { family: theme.fontMono, size: theme.bodySmSize },
    padding: 10,
    cornerRadius: 6,
    boxWidth: 8,
    boxHeight: 8,
    boxPadding: 4,
    usePointStyle: true,
    callbacks: {
      // Titre complet d'origine (les libellés de barres horizontales sont découpés en lignes sur l'axe).
      title: (items: TooltipItem<RjChartType>[]) => {
        const first = items[0];
        return first ? (input.labels[first.dataIndex] ?? first.label) : '';
      },
      label: (item: TooltipItem<RjChartType>) => {
        const raw = item.raw;
        const value = typeof raw === 'number' ? format(raw) : NO_VALUE;
        const name = input.type === 'doughnut' ? item.label : item.dataset.label;
        return ` ${name ?? ''} : ${value}`;
      },
    },
  };

  const animation = reducedMotion ? (false as const) : { duration: 200 };
  const labels = [...input.labels];

  if (input.type === 'doughnut') {
    const dataset = input.datasets[0];
    const tones = dataset?.tones ?? labels.map(() => dataset?.tone ?? 'primary');
    return {
      type: 'doughnut',
      data: {
        labels,
        datasets: dataset
          ? [
              {
                label: dataset.label,
                data: [...dataset.data] as number[],
                backgroundColor: tones.map((tone) => toneColor(theme, tone)),
                borderColor: theme.surface,
                borderWidth: 2,
                hoverOffset: 4,
              },
            ]
          : [],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation,
        cutout: '68%',
        color: theme.inkMuted,
        plugins: { tooltip },
      },
    } as ChartConfiguration;
  }

  const horizontal = input.type === 'bar' && input.horizontal === true;
  const datasets = input.datasets.map((dataset): ChartDataset => {
    const color = toneColor(theme, dataset.tone);
    if (input.type === 'line') {
      const primary = dataset.tone === 'primary';
      return {
        type: 'line',
        label: dataset.label,
        data: [...dataset.data],
        borderColor: color,
        backgroundColor: primary ? theme.thunderSoft : color,
        fill: primary ? 'origin' : false,
        borderWidth: primary ? 2 : 1.5,
        borderDash: dataset.tone === 'comparison' ? [4, 4] : [],
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 12,
        pointBackgroundColor: color,
        tension: 0.3,
        spanGaps: false,
        order: primary ? 0 : 1,
      };
    }
    return {
      type: 'bar',
      label: dataset.label,
      data: [...dataset.data],
      backgroundColor: dataset.tones ? dataset.tones.map((tone) => toneColor(theme, tone)) : color,
      borderRadius: 4,
      maxBarThickness: 32,
      categoryPercentage: 0.7,
      barPercentage: 0.9,
    };
  });

  const categoryAxis = {
    grid: { display: false },
    border: { color: theme.line },
    ticks: {
      color: theme.inkMuted,
      font: tickFont,
      maxRotation: 0,
      autoSkip: true,
      autoSkipPadding: 8,
      maxTicksLimit: horizontal ? undefined : categoryTickLimit(input.width),
    },
  } as unknown as ScaleOptionsByType<'category'>;
  const valueAxis = {
    beginAtZero: true,
    grid: { color: theme.line },
    border: { display: false },
    ticks: { color: theme.inkMuted, font: tickFont, maxTicksLimit: 5, callback: formatAxis, padding: 6 },
  } as unknown as ScaleOptionsByType<'linear'>;

  return {
    type: input.type,
    data: { labels: horizontal ? labels.map((label) => wrapCategoryLabel(label, horizontalLabelChars(input.width))) : labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation,
      indexAxis: horizontal ? 'y' : 'x',
      interaction: { mode: 'index', intersect: false, axis: horizontal ? 'y' : 'x' },
      color: theme.inkMuted,
      scales: horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
      plugins: { tooltip },
    },
  } as ChartConfiguration;
}

/**
 * Série du contrat (`TimeSeries`) → libellés de jours et jeux de données : série principale (thunder) et,
 * si présente, période précédente alignée jour par jour (info, pointillés).
 */
export function timeSeriesToChart(
  series: TimeSeries,
  labels: { readonly current: string; readonly comparison?: string },
): { labels: string[]; datasets: RjChartDataset[] } {
  const datasets: RjChartDataset[] = [{ label: labels.current, data: series.points.map((point) => point.value), tone: 'primary' }];
  if (series.comparison) {
    datasets.push({
      label: labels.comparison ?? 'Période précédente',
      data: series.points.map((_point, index) => series.comparison?.[index]?.value ?? null),
      tone: 'comparison',
    });
  }
  return { labels: series.points.map((point) => formatDay(point.date)), datasets };
}

/** Résumé chiffré pour `aria-label` du canvas : bornes, dernière valeur, ou parts d'une répartition. */
export function summarizeChart(input: RjChartInput & { readonly title: string }): string {
  const format = (value: number | null) => formatMetric(value, input.unit, { currency: input.currency });
  if (input.type === 'doughnut') {
    const dataset = input.datasets[0];
    if (!dataset) return `${input.title} : aucune donnée.`;
    const total = dataset.data.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const parts = input.labels.map((label, index) => {
      const value = dataset.data[index] ?? null;
      const share = total > 0 && value !== null ? formatMetric(value / total, 'ratio') : NO_VALUE;
      return `${label} ${format(value)} (${share})`;
    });
    return `${input.title} : ${parts.join(', ')}.`;
  }
  const first = input.labels[0];
  const last = input.labels[input.labels.length - 1];
  const parts = input.datasets.map((dataset) => {
    const values = dataset.data.filter((value): value is number => value !== null);
    if (values.length === 0) return `${dataset.label} : aucune donnée`;
    const lastValue = [...dataset.data].reverse().find((value) => value !== null) ?? null;
    return `${dataset.label} : de ${format(Math.min(...values))} à ${format(Math.max(...values))}, dernière valeur ${format(lastValue)}`;
  });
  const span = first && last && first !== last ? ` (${first} – ${last})` : '';
  return `${input.title}${span}. ${parts.join(' ; ')}.`;
}
