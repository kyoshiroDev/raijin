import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DEMO_VARIANTS, buildQualityReport, simulateHistory, type QualityReport } from '@raijin/bench-verdicts';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { describe, expect, it } from 'vitest';
import { FakeBenchApi, provideFakeBench } from '../../core/api/bench-api.testing';
import { HttpVerdictQualitySource, SIMULATION_SIZE, SimulatedVerdictQualitySource, VerdictQualitySource } from './verdict-quality-source';
import { LOAD_ERROR, VerdictQualityPage } from './verdict-quality-page';

class FakeSource extends VerdictQualitySource {
  constructor(private readonly result: () => Promise<QualityReport>) {
    super();
  }
  load(): Promise<QualityReport> {
    return this.result();
  }
}

async function setup(source?: VerdictQualitySource) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  if (source) TestBed.overrideComponent(VerdictQualityPage, { set: { providers: [{ provide: VerdictQualitySource, useValue: source }] } });
  const fixture = TestBed.createComponent(VerdictQualityPage);
  fixture.detectChanges();
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

// Rapport simulé calculé une fois, hors du délai des tests (le calcul complet prend quelques secondes sur une machine chargée).
const FULL = buildQualityReport(simulateHistory(7, 400), DEMO_VARIANTS);
const full = () => new FakeSource(() => Promise.resolve(FULL));

const small = (simulated = true) => buildQualityReport({ ...simulateHistory(3, 20), simulated }, DEMO_VARIANTS);

describe('HttpVerdictQualitySource', () => {
  function source(body: unknown) {
    const api = new FakeBenchApi().on('GET', BENCH_ROUTES.verdictQuality, body);
    TestBed.configureTestingModule({ providers: [HttpVerdictQualitySource, ...provideFakeBench(api)] });
    return { src: TestBed.inject(HttpVerdictQualitySource), api };
  }

  it('reads the report computed by the bench API (GET /api/verdicts/quality)', async () => {
    const report = small(false);
    const { src, api } = source(report);
    await expect(src.load()).resolves.toEqual(report);
    expect(api.callsTo('GET', BENCH_ROUTES.verdictQuality)).toHaveLength(1);
  });

  it('refuses a body that is not a QualityReport', async () => {
    const { src } = source({ simulated: 'non', horizons: [] });
    await expect(src.load()).rejects.toThrow('Rapport de justesse invalide.');
  });
});

describe('VerdictQualityPage', () => {
  it('source par défaut : jeu simulé déterministe de la lib', async () => {
    const report = await new SimulatedVerdictQualitySource().load();
    expect(report.simulated).toBe(true);
    expect(report.records).toBe(SIMULATION_SIZE);
  }, 30_000);

  it('données simulées : bandeau, badge, période, métriques avec IC et n', async () => {
    const { el } = await setup(full());
    expect(el.querySelector('h1')?.textContent).toContain('Justesse des verdicts');
    expect(el.querySelector('[data-testid="bench-badge"]')?.textContent).toContain('BANC DE TEST');
    expect(el.querySelector('[data-simulated-banner]')?.textContent).toContain('Données simulées');
    expect(el.querySelector('[data-records]')?.textContent?.trim()).toBe('400');
    expect(el.querySelector('[data-period]')?.textContent).toMatch(/2026 – .*2026/);
    const card = el.querySelector('[data-metric-card="dangerPrecision"]');
    expect(card?.querySelector('[data-value]')?.textContent).toMatch(/%$/);
    expect(card?.querySelector('[data-interval]')?.textContent).toContain('IC 95 %');
    expect(card?.querySelector('[data-n]')?.textContent).toMatch(/^\s*\d+ \/ \d+\s*$/);
    // Cartes sous 768 px, tableau au-delà : les deux rendus existent, l'affichage est piloté par les classes.
    expect(el.querySelector('[data-metric-table]')?.closest('div')?.classList).toContain('md:block');
    expect(el.querySelector('[data-metric-card]')?.closest('ul')?.classList).toContain('md:hidden');
    expect(el.querySelector('[data-disclaimer]')?.textContent).toContain('Pas un conseil en investissement');
    expect(el.querySelector('img, app-mascot, [data-mascot]')).toBeNull();
  });

  it('change d’horizon et de classe positive (aria-pressed)', async () => {
    const { el, fixture } = await setup(full());
    expect(el.querySelector('#accuracy-title')?.textContent).toContain('7 jours');
    const button = el.querySelector<HTMLButtonElement>('[data-horizon="24h"]');
    button?.click();
    fixture.detectChanges();
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-horizon="7d"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('#accuracy-title')?.textContent).toContain('24 h');
    const before = el.querySelector('[data-metric-row="baseRate"] [data-n]')?.textContent;
    el.querySelector<HTMLButtonElement>('[data-positive="rugOrDead"]')?.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-metric-row="baseRate"] [data-n]')?.textContent).not.toBe(before);
  });

  it('pouvoir prédictif et comparaison avec la variante choisie', async () => {
    const { el, fixture } = await setup(full());
    expect(el.querySelectorAll('[data-signals] [data-signal-table] tbody tr').length).toBeGreaterThan(3);
    expect(el.querySelector('[data-replay-meta]')?.textContent).toContain('1.0.0-variante.top10-40');
    const select = el.querySelector<HTMLSelectElement>('[data-variant-select]');
    expect(select?.options).toHaveLength(2);
    if (select) {
      select.value = 'liquidite-20k';
      select.dispatchEvent(new Event('change'));
    }
    fixture.detectChanges();
    expect(el.querySelector('[data-replay-meta]')?.textContent).toContain('1.0.0-variante.liquidite-20k');
    expect(Number(el.querySelector('[data-changes] [data-changed]')?.textContent)).toBeGreaterThan(0);
    expect(el.querySelector('[data-change-matrix] caption')?.textContent).toContain('Moteur actuel');
  });

  it('échantillon insuffisant : aucun pourcentage, la mention et n', async () => {
    const { el } = await setup(new FakeSource(() => Promise.resolve(small())));
    const accuracy = el.querySelector('[data-accuracy]') as HTMLElement;
    expect(accuracy.querySelector('[data-value]')).toBeNull();
    expect(accuracy.querySelectorAll('[data-insufficient]').length).toBeGreaterThanOrEqual(10);
    expect(accuracy.querySelector('[data-metric-card="dangerPrecision"]')?.textContent).toContain('Échantillon insuffisant');
    expect(accuracy.querySelector('[data-metric-card="dangerPrecision"] [data-n]')?.textContent).toContain('minimum 30');
    expect(el.querySelector('[data-variants] [data-value]')).toBeNull();
    expect(el.querySelector('[data-variants] [data-delta]')?.textContent).toContain('échantillon insuffisant');
  });

  it('données réelles : pas de bandeau « Données simulées »', async () => {
    const { el } = await setup(new FakeSource(() => Promise.resolve(small(false))));
    expect(el.querySelector('[data-simulated-banner]')).toBeNull();
    expect(el.querySelector('[data-accuracy]')).not.toBeNull();
  });

  it('erreur de chargement : message et nouvel essai', async () => {
    let fail = true;
    const { el, fixture } = await setup(new FakeSource(() => (fail ? Promise.reject(new Error('x')) : Promise.resolve(small()))));
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(LOAD_ERROR);
    fail = false;
    el.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelector('[data-accuracy]')).not.toBeNull();
  });

  it('chargement : état d’attente annoncé', async () => {
    const { el } = await setup(new FakeSource(() => new Promise<QualityReport>(() => undefined)));
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Chargement');
  });

  it('aucune variante : message dédié', async () => {
    const report = buildQualityReport(simulateHistory(3, 20), []);
    const { el } = await setup(new FakeSource(() => Promise.resolve(report)));
    expect(el.querySelector('[data-no-variant]')).not.toBeNull();
  });
});
