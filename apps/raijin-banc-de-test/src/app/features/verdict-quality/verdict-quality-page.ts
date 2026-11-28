import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { VERDICT_LABELS, type Verdict } from '@raijin/shared-contracts';
import {
  FOLLOW_UP_HORIZONS,
  KNOWN_OUTCOMES,
  type FollowUpHorizon,
  type KnownOutcome,
  type PositiveClass,
  type QualityReport,
} from '@raijin/bench-verdicts';
import { PageHeader } from '../../shared/ui/page-header';
import { ProportionValue } from './components/proportion-value';
import { SignalPowerTable } from './components/signal-power-table';
import { VariantComparison } from './components/variant-comparison';
import { formatPeriod } from '@raijin/bench-web-logic/verdict-quality';
import { HttpVerdictQualitySource, VerdictQualitySource } from './verdict-quality-source';

export const HORIZON_LABELS: Readonly<Record<FollowUpHorizon, string>> = { '24h': '24 h', '72h': '72 h', '7d': '7 jours' };

const POSITIVE_LABELS: Readonly<Record<PositiveClass, string>> = { rug: 'Rug', rugOrDead: 'Rug ou token mort' };
const OUTCOME_LABELS: Readonly<Record<KnownOutcome, string>> = { rug: 'Rug', dead: 'Mort', alive: 'Vivant' };

type AccuracyMetric = 'dangerPrecision' | 'dangerRecall' | 'falseSafeRate' | 'cautionPositiveRate' | 'baseRate';

export const ACCURACY_METRICS: readonly { key: AccuracyMetric; label: string; help: string }[] = [
  { key: 'dangerPrecision', label: 'Précision du Danger', help: 'Part des verdicts Danger suivis d’un rug.' },
  { key: 'dangerRecall', label: 'Rappel du Danger', help: 'Part des rugs signalés Danger à l’avance.' },
  { key: 'falseSafeRate', label: 'Faux « Sain »', help: 'Part des verdicts Sain suivis d’un rug.' },
  { key: 'cautionPositiveRate', label: 'Rugs parmi les Prudence', help: 'Prudence n’est ni positif ni négatif : affiché à part.' },
  { key: 'baseRate', label: 'Taux de rug global', help: 'Référence du lift des signaux.' },
];

export const LOAD_ERROR = 'Impossible de charger la justesse des verdicts.';

/**
 * /justesse — justesse des verdicts du moteur par horizon (24 h, 72 h, 7 j), pouvoir prédictif des
 * signaux, comparaison moteur actuel / variante. Le banc mesure le risque pour améliorer les
 * verdicts de Raijin, jamais une stratégie de gain. Aucun calcul ici : tout vient de
 * `@raijin/bench-verdicts`, calculé par l'API du banc, via le port `VerdictQualitySource` (simulé dans les tests).
 */
@Component({
  selector: 'app-verdict-quality-page',
  imports: [PageHeader, ProportionValue, RouterLink, SignalPowerTable, VariantComparison],
  providers: [{ provide: VerdictQualitySource, useClass: HttpVerdictQualitySource }],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header>
      <h1 class="text-xl font-black tracking-tight">Justesse des verdicts</h1>
    </app-page-header>
    <main class="mx-auto max-w-lg space-y-4 px-safe pt-4 pb-6 md:max-w-4xl">
      <a routerLink="/performance" class="press inline-flex min-h-11 items-center text-sm font-semibold text-muted hover:text-fg">← Performance</a>

      @if (error(); as e) {
        <div class="card space-y-3 text-center" role="alert">
          <p class="text-sm text-bear">{{ e }}</p>
          <button type="button" class="btn-ghost w-full" (click)="load()">Réessayer</button>
        </div>
      } @else if (report(); as r) {
        @if (r.simulated) {
          <div class="rounded-xl border border-info/40 bg-info/10 px-3 py-2 text-sm text-info" role="note" data-simulated-banner>
            <p class="font-semibold">Données simulées</p>
            <p class="text-xs">
              Jeu de test déterministe : aucun de ces chiffres ne mesure un résultat réel.
            </p>
          </div>
        }

        <p class="text-sm text-muted">
          Le banc mesure si les verdicts du moteur annoncent le risque à l’avance (rug : LP retirée, chute ≥ 90 %, nouveaux
          tokens émis). Ce n’est pas une stratégie de gain.
        </p>
        <dl class="card grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" data-meta>
          <div class="col-span-2"><dt class="text-label text-muted">Période</dt><dd data-period>{{ period(r.period) }}</dd></div>
          <div><dt class="text-label text-muted">Moteur mesuré</dt><dd class="font-mono">{{ r.engineVersion }}</dd></div>
          <div><dt class="text-label text-muted">Verdicts</dt><dd class="tabular-nums" data-records>{{ r.records }}</dd></div>
        </dl>

        <div class="space-y-2">
          <p id="horizon-label" class="text-xs font-semibold text-muted">Horizon de suivi</p>
          <div role="group" aria-labelledby="horizon-label" class="grid grid-cols-3 gap-1 rounded-xl border border-line bg-surface p-1">
            @for (h of horizons; track h) {
              <button
                type="button"
                class="press min-h-11 rounded-lg text-sm font-semibold"
                [class]="horizon() === h ? 'seg-active' : 'text-muted hover:text-fg'"
                [attr.aria-pressed]="horizon() === h"
                [attr.data-horizon]="h"
                (click)="horizon.set(h)"
              >
                {{ horizonLabel[h] }}
              </button>
            }
          </div>
          <p id="positive-label" class="text-xs font-semibold text-muted">Issue comptée comme positive</p>
          <div role="group" aria-labelledby="positive-label" class="grid grid-cols-2 gap-1 rounded-xl border border-line bg-surface p-1">
            @for (p of positives; track p) {
              <button
                type="button"
                class="press min-h-11 rounded-lg text-sm font-semibold"
                [class]="positive() === p ? 'seg-active' : 'text-muted hover:text-fg'"
                [attr.aria-pressed]="positive() === p"
                [attr.data-positive]="p"
                (click)="positive.set(p)"
              >
                {{ positiveLabel[p] }}
              </button>
            }
          </div>
        </div>

        @if (current(); as q) {
          @let a = positive() === 'rug' ? q.accuracy : q.accuracyRugOrDead;
          <section aria-labelledby="accuracy-title" class="space-y-2" data-accuracy>
            <h2 id="accuracy-title" class="text-xs font-semibold tracking-wide text-muted uppercase">
              Justesse à {{ horizonLabel[q.horizon] }}
            </h2>
            <p class="text-xs text-muted" data-coverage>
              {{ a.counts.evaluated }} verdicts avec une issue connue sur {{ a.counts.records }} · {{ a.counts.unknown }} issues inconnues
              (exclues) · {{ q.coverage.missingAtHorizon }} sans observation à cet horizon · {{ q.coverage.outOfWindow }} observations hors
              fenêtre écartées
            </p>

            <ul class="space-y-2 md:hidden" aria-label="Métriques de justesse">
              @for (m of metrics; track m.key) {
                <li class="card space-y-1" [attr.data-metric-card]="m.key">
                  <p class="text-sm font-semibold">{{ m.label }}</p>
                  <app-proportion-value [p]="a[m.key]" [minSample]="r.minSample" />
                  <p class="text-xs text-muted">{{ m.help }}</p>
                </li>
              }
            </ul>
            <div class="hidden overflow-x-auto md:block">
              <table class="w-full text-left text-sm" data-metric-table>
                <caption class="sr-only">Métriques de justesse à {{ horizonLabel[q.horizon] }}</caption>
                <thead class="text-xs text-muted">
                  <tr>
                    <th scope="col" class="py-2 pr-3 font-semibold">Métrique</th>
                    <th scope="col" class="py-2 pr-3 font-semibold">Valeur, IC 95 %, n</th>
                    <th scope="col" class="py-2 font-semibold">Lecture</th>
                  </tr>
                </thead>
                <tbody>
                  @for (m of metrics; track m.key) {
                    <tr class="border-t border-line align-top" [attr.data-metric-row]="m.key">
                      <th scope="row" class="py-2 pr-3 font-semibold">{{ m.label }}</th>
                      <td class="py-2 pr-3"><app-proportion-value [p]="a[m.key]" [minSample]="r.minSample" [compact]="true" /></td>
                      <td class="py-2 text-xs text-muted">{{ m.help }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            <div class="card overflow-x-auto">
              <table class="w-full text-left text-sm" data-outcome-matrix>
                <caption class="pb-2 text-left text-xs text-muted">Verdict au moment de l’analyse × issue à {{ horizonLabel[q.horizon] }} (effectifs)</caption>
                <thead class="text-xs text-muted">
                  <tr>
                    <th scope="col" class="py-1 pr-2 font-semibold">Verdict</th>
                    @for (o of outcomes; track o) {
                      <th scope="col" class="py-1 pr-2 font-semibold">{{ outcomeLabel[o] }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (v of verdicts; track v) {
                    <tr class="border-t border-line" [attr.data-matrix-row]="v">
                      <th scope="row" class="py-1 pr-2 font-semibold">{{ verdictLabel[v] }}</th>
                      @for (o of outcomes; track o) {
                        <td class="py-1 pr-2 tabular-nums">{{ a.matrix[v][o] }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="signals-title" class="space-y-3" data-signals>
            <h2 id="signals-title" class="text-xs font-semibold tracking-wide text-muted uppercase">Pouvoir prédictif des signaux (rug)</h2>
            <p class="text-xs text-muted">
              Lift = taux de rug des porteurs / taux global. Classé seulement à partir de {{ r.minSupport }} porteurs ; taux affiché à
              partir de {{ r.minSample }}.
            </p>
            <app-signal-power-table caption="Par code de raison" [rows]="q.signals.byReason" [minSample]="r.minSample" />
            <app-signal-power-table caption="Par contrôle signalé" [rows]="q.signals.byCheck" [minSample]="r.minSample" />
          </section>

          <section aria-labelledby="variant-title" class="space-y-2" data-variants>
            <h2 id="variant-title" class="text-xs font-semibold tracking-wide text-muted uppercase">Moteur actuel vs variante (rug)</h2>
            <p class="text-xs text-muted">
              Mêmes faits, mêmes issues. Les variantes se règlent sur la période de calibration ({{ period(r.calibrationPeriod) }}) et se
              jugent ici, sur la période de validation, plus récente. Une variante n’entre dans Raijin que par une modification revue du
              moteur.
            </p>
            <app-variant-comparison [replay]="q.replay" [validationPeriod]="r.validationPeriod" [minSample]="r.minSample" />
          </section>
        }
      } @else {
        <p class="py-10 text-center text-muted" role="status">Chargement de la justesse des verdicts…</p>
      }

      <p class="text-center text-label text-muted" data-disclaimer>
        Mesure de risque du banc de test privé : intervalles de Wilson à 95 %, n = verdicts avec une issue connue. Aucun chiffre sous
        {{ report()?.minSample ?? 30 }} cas n’est interprétable ni réutilisable pour communiquer. Pas un conseil en investissement.
      </p>
    </main>
  `,
})
export class VerdictQualityPage implements OnInit {
  private readonly source = inject(VerdictQualitySource);

  protected readonly report = signal<QualityReport | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly horizon = signal<FollowUpHorizon>('7d');
  protected readonly positive = signal<PositiveClass>('rug');

  protected readonly current = computed(() => this.report()?.horizons.find((item) => item.horizon === this.horizon()) ?? null);

  protected readonly horizons = FOLLOW_UP_HORIZONS;
  protected readonly horizonLabel = HORIZON_LABELS;
  protected readonly positives: readonly PositiveClass[] = ['rug', 'rugOrDead'];
  protected readonly positiveLabel = POSITIVE_LABELS;
  protected readonly metrics = ACCURACY_METRICS;
  protected readonly outcomes = KNOWN_OUTCOMES;
  protected readonly outcomeLabel = OUTCOME_LABELS;
  protected readonly verdicts: readonly Verdict[] = ['safe', 'warn', 'danger'];
  protected readonly verdictLabel = VERDICT_LABELS;
  protected readonly period = formatPeriod;

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.error.set(null);
    try {
      this.report.set(await this.source.load());
    } catch {
      this.error.set(LOAD_ERROR);
    }
  }
}
