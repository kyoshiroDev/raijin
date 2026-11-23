import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type AdminKpi } from '@raijin/shared-contracts';
import { RjChart } from './chart/chart';
import { buildChartConfig, readChartTheme, summarizeChart, timeSeriesToChart, type RjChartDataset, type RjChartTheme } from './chart/chart-config';
import { RJ_CHART_LOADER } from './chart/chart-loader';
import { RjDataTable, resolveRowLink, type RjTableColumn } from './data-table';
import { provideRouter } from '@angular/router';
import { describeChange, formatChange, formatMetric } from './format';
import { RjKpiCard } from './kpi-card';
import { RjServiceState } from './service-state';
import { FakeCharts, settle } from '../testing/harness';

const THEME: RjChartTheme = {
  thunder: 'T',
  thunderSoft: 'TS',
  info: 'I',
  safe: 'S',
  warn: 'W',
  danger: 'D',
  ink: 'K',
  inkMuted: 'KM',
  line: 'L',
  surface: 'SU',
  surfaceRaised: 'SR',
  fontSans: 'Inter',
  fontMono: 'Mono',
  labelSize: 12,
  bodySmSize: 13,
};

describe('format', () => {
  it('formate selon l’unité (fr-FR)', () => {
    expect(formatMetric(412_350, 'cents')).toMatch(/^4\s123,50\s€$/);
    expect(formatMetric(0.184, 'ratio')).toMatch(/^18,4\s%$/);
    expect(formatMetric(1520, 'ms')).toBe('1,5 s');
    expect(formatMetric(75, 'seconds')).toBe('1 min 15 s');
    expect(formatMetric(null, 'count')).toBe('—');
  });

  it('variation : signe explicite et vrai signe moins', () => {
    expect(formatChange(0.124)).toMatch(/^\+12,4\s%$/);
    expect(formatChange(-0.03)).toMatch(/^−3\s%$/);
    expect(describeChange(-0.03)).toMatch(/^en baisse de 3\s%$/);
  });
});

describe('thème des graphiques', () => {
  it('lit les couleurs dans les variables CSS des tokens', () => {
    const root = document.documentElement;
    root.style.setProperty('--color-thunder', '#facc15');
    root.style.setProperty('--color-info', '#38bdf8');
    root.style.setProperty('--text-label', '12px');
    const theme = readChartTheme(root);
    expect(theme.thunder).toBe('#facc15');
    expect(theme.info).toBe('#38bdf8');
    expect(theme.labelSize).toBe(12);
    root.style.removeProperty('--color-thunder');
    root.style.removeProperty('--color-info');
    root.style.removeProperty('--text-label');
  });

  it('série principale en thunder, comparaison en info pointillée', () => {
    const datasets: RjChartDataset[] = [
      { label: 'Inscriptions', data: [1, 2, null], tone: 'primary' },
      { label: 'Période précédente', data: [1, 1, 1], tone: 'comparison' },
    ];
    const config = buildChartConfig({ type: 'line', labels: ['a', 'b', 'c'], datasets, unit: 'count', width: 360 }, THEME, false);
    const [main, comparison] = config.data.datasets as unknown as Record<string, unknown>[];
    expect(main).toMatchObject({ borderColor: 'T', backgroundColor: 'TS', fill: 'origin' });
    expect(comparison).toMatchObject({ borderColor: 'I', borderDash: [4, 4], fill: false });
    // 360 px : 4 graduations au plus sur l'axe des dates.
    expect((config.options?.scales?.['x']?.ticks as { maxTicksLimit?: number }).maxTicksLimit).toBe(4);
  });

  it('répartition des verdicts : couleurs safe / warn / danger ; mouvement réduit : aucune animation', () => {
    const config = buildChartConfig(
      { type: 'doughnut', labels: ['Sain', 'Prudence', 'Danger'], datasets: [{ label: 'Analyses', data: [5, 3, 2], tone: 'primary', tones: ['safe', 'warn', 'danger'] }], unit: 'count' },
      THEME,
      true,
    );
    expect((config.data.datasets[0] as unknown as { backgroundColor: string[] }).backgroundColor).toEqual(['S', 'W', 'D']);
    expect(config.options?.animation).toBe(false);
  });

  it('résumé chiffré et conversion d’une série du contrat', () => {
    const chart = timeSeriesToChart(
      { key: 'signups', unit: 'count', points: [{ date: '2026-11-21', value: 3 }, { date: '2026-11-22', value: 5 }], comparison: [{ date: '2026-11-19', value: 2 }, { date: '2026-11-20', value: 4 }] },
      { current: 'Inscriptions' },
    );
    expect(chart.labels).toEqual(['21 nov.', '22 nov.']);
    expect(chart.datasets[1]).toMatchObject({ tone: 'comparison', data: [2, 4] });
    expect(summarizeChart({ type: 'line', title: 'Inscriptions', unit: 'count', ...chart })).toContain('Inscriptions : de 3 à 5, dernière valeur 5');
  });
});

@Component({
  imports: [RjChart],
  template: `<rj-chart type="line" title="Inscriptions par jour" [labels]="labels()" [datasets]="datasets()" />`,
})
class ChartHost {
  readonly labels = signal(['21 nov.', '22 nov.']);
  readonly datasets = signal<RjChartDataset[]>([{ label: 'Inscriptions', data: [3, 5], tone: 'primary' }]);
}

describe('rj-chart', () => {
  function setup() {
    const charts = new FakeCharts();
    TestBed.configureTestingModule({ providers: [{ provide: RJ_CHART_LOADER, useValue: () => Promise.resolve(charts.factory) }] });
    const fixture = TestBed.createComponent(ChartHost);
    fixture.detectChanges();
    return { fixture, charts, root: fixture.nativeElement as HTMLElement };
  }

  it('canvas accessible et tableau de données alternatif', async () => {
    const { fixture, charts, root } = setup();
    await settle();
    await fixture.whenStable();
    expect(charts.created).toHaveLength(1);
    const canvas = root.querySelector('canvas');
    expect(canvas?.getAttribute('role')).toBe('img');
    expect(canvas?.getAttribute('aria-label')).toContain('dernière valeur 5');

    const toggle = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('Voir les données'));
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    toggle?.click();
    await fixture.whenStable();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const rows = Array.from(root.querySelectorAll('tbody tr')).map((row) => Array.from(row.children).map((cell) => cell.textContent?.trim()).join(' '));
    expect(rows).toEqual(['21 nov. 3', '22 nov. 5']);
    expect(root.querySelector('table caption')?.textContent).toContain('Inscriptions par jour');
  });

  it('met à jour le graphique existant quand les données changent, le détruit à la fin', async () => {
    const { fixture, charts } = setup();
    await settle();
    await fixture.whenStable();
    fixture.componentInstance.datasets.set([{ label: 'Inscriptions', data: [4, 9], tone: 'primary' }]);
    await fixture.whenStable();
    const chart = charts.last;
    expect(charts.created).toHaveLength(1);
    expect(charts.updates).toBeGreaterThan(0);
    expect((chart?.data.datasets[0] as unknown as { data: number[] }).data).toEqual([4, 9]);
    fixture.destroy();
    expect(charts.destroyed).toBe(1);
  });

  it('Chart.js indisponible : le tableau prend la place du graphique', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: RJ_CHART_LOADER, useValue: () => Promise.reject(new Error('chunk')) }] });
    const fixture = TestBed.createComponent(ChartHost);
    fixture.detectChanges();
    await settle();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Les chiffres restent lisibles dans le tableau');
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
  });
});

@Component({
  imports: [RjKpiCard],
  template: `<rj-kpi-card [kpi]="kpi()" />`,
})
class KpiHost {
  readonly kpi = signal<AdminKpi>({
    key: 'churn_rate',
    unit: 'ratio',
    value: 0.031,
    previous: 0.024,
    change: 0.292,
    higherIsBetter: false,
    source: 'internal',
    status: 'ok',
  });
}

describe('rj-kpi-card', () => {
  async function render(kpi?: Partial<AdminKpi>) {
    const fixture = TestBed.createComponent(KpiHost);
    if (kpi) fixture.componentInstance.kpi.update((current) => ({ ...current, ...kpi }));
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('chiffre mono, variation avec icône + signe + phrase, couleur inversée pour le churn', async () => {
    const root = await render();
    expect(root.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Churn');
    expect(root.querySelector('.tabular')?.textContent).toMatch(/3,1\s%/);
    const change = root.querySelector('.text-danger');
    expect(change?.querySelector('rj-icon svg')).not.toBeNull();
    expect(change?.textContent).toMatch(/\+29,2\s%/);
    expect(change?.textContent).toContain('en hausse de 29,2');
  });

  it('hausse d’un indicateur positif en vert', async () => {
    const root = await render({ key: 'signups', higherIsBetter: true });
    expect(root.querySelector('.text-safe')).not.toBeNull();
  });

  it('« Nouveau » si la période précédente valait 0, « Non connecté » sans GA4', async () => {
    expect((await render({ previous: 0, change: null })).textContent).toContain('Nouveau');
    TestBed.resetTestingModule();
    const root = await render({ status: 'not_connected', value: null, change: null });
    expect(root.textContent).toContain('Non connecté');
    expect(root.textContent).toContain('—');
  });
});

describe('rj-service-state et rj-data-table', () => {
  it('« Non connecté » et « Données simulées »', async () => {
    const fixture = TestBed.createComponent(RjServiceState);
    fixture.componentRef.setInput('service', 'ga4');
    fixture.componentRef.setInput('state', { status: 'not_connected' });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Google Analytics 4');
    expect(fixture.nativeElement.textContent).toContain('Non connecté');
    fixture.componentRef.setInput('variant', 'inline');
    fixture.componentRef.setInput('state', { status: 'connected', simulated: true, fetchedAt: '2026-11-22T10:00:00.000Z', cachedUntil: '2026-11-22T11:00:00.000Z' });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Données simulées');
  });

  it('tableau : texte hostile affiché tel quel (jamais interprété), chiffres formatés', async () => {
    interface Row { path: string; views: number }
    const fixture = TestBed.createComponent(RjDataTable<Row>);
    const columns: RjTableColumn<Row>[] = [
      { key: 'path', label: 'Page', value: (row) => row.path, primary: true },
      { key: 'views', label: 'Vues', value: (row) => row.views, unit: 'count' },
    ];
    fixture.componentRef.setInput('caption', 'Pages');
    fixture.componentRef.setInput('columns', columns);
    fixture.componentRef.setInput('rows', [{ path: '<img src=x onerror=alert(1)>', views: 12_345 }]);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.querySelector('td')?.textContent?.trim()).toMatch(/^12\s345$/);
    // Région défilante nommée et atteignable au clavier (axe scrollable-region-focusable).
    const region = root.querySelector('.overflow-auto');
    expect(region?.getAttribute('role')).toBe('region');
    expect(region?.getAttribute('tabindex')).toBe('0');
    expect(region?.getAttribute('aria-label')).toBe('Pages');
  });
});

describe('rj-data-table : lignes cliquables', () => {
  it('chemin + paramètres de requête : lien correct, jamais de « ? » encodé dans le chemin', async () => {
    interface Row { id: string; email: string }
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(RjDataTable<Row>);
    fixture.componentRef.setInput('caption', 'Comptes');
    fixture.componentRef.setInput('columns', [{ key: 'email', label: 'E-mail', value: (row: Row) => row.email, primary: true }]);
    fixture.componentRef.setInput('rows', [{ id: 'u1', email: 'a@exemple.fr' }]);
    fixture.componentRef.setInput('rowLink', (row: Row) => ({ path: '/admin/utilisateurs', queryParams: { fiche: row.id } }));
    await fixture.whenStable();
    const hrefs = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toBe('/admin/utilisateurs?fiche=u1');
  });

  it('une chaîne avec « ? » est découpée en chemin + requête', () => {
    expect(resolveRowLink('/admin/utilisateurs?fiche=u2')).toEqual({ path: '/admin/utilisateurs', queryParams: { fiche: 'u2' } });
    expect(resolveRowLink('/admin/sante')).toEqual({ path: '/admin/sante', queryParams: null });
    expect(resolveRowLink(null)).toBeNull();
  });
});
