import { ChangeDetectionStrategy, Component, computed, inject, type OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SHADOW_ACCEPTANCE, SHADOW_TABLES, type ShadowTable, type ShadowTableStatus } from '@raijin/bench-contracts';
import { PageHeader } from '../../shared/ui/page-header';
import {
  ACCEPTANCE_LABEL,
  SHADOW_TABLE_LABEL,
  SHADOW_WINDOWS,
  TABLE_STATUS_LABEL,
  dayLevel,
  formatDay,
  formatDiff,
  formatRows,
  toleranceLabel,
  type DiffLevel,
  type ShadowWindow,
} from './shadow-comparison';
import { SHADOW_MSG, ShadowComparisonStore } from './shadow-comparison-store';

const SNAPSHOT_AT = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });

const LEVEL_CLASS: Readonly<Record<DiffLevel, string>> = { none: 'text-muted', ok: 'text-fg', notice: 'text-warn font-semibold', info: 'text-muted' };

const STATUS_CLASS: Readonly<Record<ShadowTableStatus, string>> = {
  pass: 'text-bull',
  fail: 'text-bear font-semibold',
  insufficient: 'text-warn',
  inconclusive: 'text-muted',
  info: 'text-muted',
};

/**
 * /comparaison — mode ombre : la collecte du VPS comparée, table par table et jour par jour, à l'instantané Supabase
 * (`shadow_ref`). Écarts en %, mints présents d'un seul côté. Cartes sous 768 px, tableau au-delà. Lecture seule.
 */
@Component({
  selector: 'app-shadow-comparison-page',
  imports: [PageHeader, RouterLink],
  providers: [ShadowComparisonStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header>
      <h1 class="text-xl font-black tracking-tight">Comparaison mode ombre</h1>
    </app-page-header>
    <main class="mx-auto max-w-lg space-y-4 px-safe pt-4 pb-6 md:max-w-4xl">
      <a routerLink="/performance" class="press inline-flex min-h-11 items-center text-sm font-semibold text-muted hover:text-fg">← Performance</a>

      <p class="text-sm text-muted">
        Collecte du VPS comparée à l’instantané Supabase importé par l’utilisateur (<code>bench-migrate.sh --shadow-snapshot</code>).
        Lignes par jour (UTC). Seuils officiels de bascule (docs/BENCH.md §12) : {{ acceptance.minFullDays }} jours UTC complets
        au minimum, {{ acceptance.minRefRows }} lignes de référence par table, écarts tolérés indiqués par table.
      </p>

      <div class="space-y-2">
        <p id="window-label" class="text-xs font-semibold text-muted">Période</p>
        <div role="group" aria-labelledby="window-label" class="grid grid-cols-4 gap-1 rounded-xl border border-line bg-surface p-1">
          @for (w of windows; track w) {
            <button
              type="button"
              class="press min-h-11 rounded-lg text-sm font-semibold"
              [class]="store.window() === w ? 'seg-active' : 'text-muted hover:text-fg'"
              [attr.aria-pressed]="store.window() === w"
              [attr.data-window]="w"
              (click)="selectWindow(w)"
            >
              {{ windowLabel(w) }}
            </button>
          }
        </div>
        <label for="shadow-table" class="block text-xs font-semibold text-muted">Table</label>
        <select id="shadow-table" class="field" [value]="store.table() ?? ''" (change)="selectTable($event)">
          <option value="">Toutes les tables</option>
          @for (t of tables; track t) {
            <option [value]="t">{{ tableLabel[t] }}</option>
          }
        </select>
      </div>

      @switch (store.state()) {
        @case ('error') {
          <div class="card space-y-3 text-center" role="alert">
            <p class="text-sm text-bear">{{ msg.loadFailed }}</p>
            <button type="button" class="btn-ghost w-full" (click)="store.load()">Réessayer</button>
          </div>
        }
        @case ('unavailable') {
          <p class="card text-sm text-muted" role="status" data-unavailable>{{ msg.unavailable }}</p>
        }
        @default {
          @if (store.data(); as d) {
            <p class="text-sm" data-snapshot>
              @if (snapshotAt(); as at) {
                Instantané de référence : {{ at }} · du {{ day(d.from) }} au {{ day(d.to) }}
              } @else {
                <span class="text-warn">Aucun instantané importé : seules les lignes du VPS sont comptées.</span>
              }
            </p>

            @if (store.acceptance(); as a) {
              <section aria-labelledby="shadow-verdict-title" class="card space-y-2 text-sm" data-acceptance [attr.data-status]="a.status">
                <h2 id="shadow-verdict-title" class="text-xs font-semibold tracking-wide text-muted uppercase">Verdict de bascule (données)</h2>
                <p [class]="a.status === 'pass' ? 'text-bull font-semibold' : a.status === 'fail' ? 'text-bear font-semibold' : 'text-warn'" data-verdict>
                  {{ acceptanceLabel[a.status] }}
                </p>
                @if (a.status !== 'no_snapshot') {
                  <p class="text-xs text-muted tabular-nums">{{ a.snapshotFullDays }} jour(s) UTC complet(s) dans l’instantané.</p>
                  <ul class="space-y-1">
                    @for (t of a.tables; track t.table) {
                      <li [attr.data-acceptance-table]="t.table">
                        <span class="font-semibold">{{ tableLabel[t.table] }}</span> :
                        <span [class]="statusClass[t.status]">{{ statusLabel[t.status] }}</span>
                        <span class="text-xs text-muted tabular-nums"> · n réf. {{ rows(t.refRows) }} · écart {{ diff(t.diffPct) }} · {{ tolerance(t.table) }}</span>
                        @for (r of t.reasons; track r) {
                          <span class="block text-xs text-bear">{{ r }}</span>
                        }
                      </li>
                    }
                  </ul>
                }
              </section>
            }

            @if (store.summaries().length === 0) {
              <p class="card text-sm text-muted" data-empty>Aucune ligne sur cette période.</p>
            } @else {
              <section aria-labelledby="shadow-summary-title" class="space-y-2">
                <h2 id="shadow-summary-title" class="text-xs font-semibold tracking-wide text-muted uppercase">Par table, sur la période</h2>
                <ul class="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                  @for (s of store.summaries(); track s.table) {
                    <li class="card space-y-1 text-sm" [attr.data-summary]="s.table">
                      <p class="font-semibold">{{ s.label }}</p>
                      <p class="tabular-nums">VPS {{ rows(s.vpsRows) }} · réf. {{ rows(s.refRows) }}</p>
                      <p class="tabular-nums" [class]="levelClass[s.level]" data-diff>Écart {{ diff(s.diffPct) }}</p>
                      @if (s.onlyVps !== null || s.onlyRef !== null) {
                        <p class="text-xs text-muted tabular-nums">Mints seulement VPS {{ rows(s.onlyVps) }} · seulement réf. {{ rows(s.onlyRef) }}</p>
                      }
                    </li>
                  }
                </ul>
              </section>

              <section aria-labelledby="shadow-days-title" class="space-y-2">
                <h2 id="shadow-days-title" class="text-xs font-semibold tracking-wide text-muted uppercase">Par jour</h2>
                <ul class="space-y-2 md:hidden" aria-label="Comparaison par table et par jour">
                  @for (r of store.rows(); track r.table + r.day) {
                    <li class="card space-y-1 text-sm" [attr.data-day-card]="r.table + ':' + r.day">
                      <p class="flex items-baseline justify-between gap-2">
                        <span class="font-semibold">{{ tableLabel[r.table] }}</span>
                        <span class="text-xs text-muted tabular-nums">{{ day(r.day) }}</span>
                      </p>
                      <p class="tabular-nums">VPS {{ rows(r.vps_rows) }} · réf. {{ rows(r.ref_rows) }}</p>
                      <p class="tabular-nums" [class]="levelClass[level(r)]">Écart {{ diff(r.diff_pct) }}</p>
                      @if (r.only_vps_count !== null || r.only_ref_count !== null) {
                        <details class="text-xs">
                          <summary class="min-h-11 cursor-pointer py-2 text-muted">
                            Mints d’un seul côté : VPS {{ rows(r.only_vps_count) }} · réf. {{ rows(r.only_ref_count) }}
                          </summary>
                          @if (r.invalid_mint_count) {
                            <p class="mt-1 text-warn" data-invalid-mints>Dont {{ rows(r.invalid_mint_count) }} adresse(s) invalide(s), comptée(s) mais hors exemples.</p>
                          }
                          @if (r.only_vps_sample.length > 0) {
                            <p class="mt-1 text-muted">Exemples présents seulement sur le VPS :</p>
                            <ul class="font-mono break-all" data-only-vps>
                              @for (m of r.only_vps_sample; track m) {
                                <li>{{ m }}</li>
                              }
                            </ul>
                          }
                          @if (r.only_ref_sample.length > 0) {
                            <p class="mt-1 text-muted">Exemples présents seulement dans la référence :</p>
                            <ul class="font-mono break-all" data-only-ref>
                              @for (m of r.only_ref_sample; track m) {
                                <li>{{ m }}</li>
                              }
                            </ul>
                          }
                        </details>
                      }
                    </li>
                  }
                </ul>
                <div class="hidden overflow-x-auto md:block">
                  <table class="w-full text-left text-sm" data-day-table>
                    <caption class="sr-only">Comparaison par table et par jour</caption>
                    <thead class="text-xs text-muted">
                      <tr>
                        <th scope="col" class="py-2 pr-3 font-semibold">Table</th>
                        <th scope="col" class="py-2 pr-3 font-semibold">Jour</th>
                        <th scope="col" class="py-2 pr-3 text-right font-semibold">VPS</th>
                        <th scope="col" class="py-2 pr-3 text-right font-semibold">Réf.</th>
                        <th scope="col" class="py-2 pr-3 text-right font-semibold">Écart</th>
                        <th scope="col" class="py-2 pr-3 text-right font-semibold">Seulement VPS</th>
                        <th scope="col" class="py-2 text-right font-semibold">Seulement réf.</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of store.rows(); track r.table + r.day) {
                        <tr class="border-t border-line align-top" [attr.data-day-row]="r.table + ':' + r.day">
                          <th scope="row" class="py-2 pr-3 font-semibold">{{ tableLabel[r.table] }}</th>
                          <td class="py-2 pr-3 tabular-nums">{{ day(r.day) }}</td>
                          <td class="py-2 pr-3 text-right tabular-nums">{{ rows(r.vps_rows) }}</td>
                          <td class="py-2 pr-3 text-right tabular-nums">{{ rows(r.ref_rows) }}</td>
                          <td class="py-2 pr-3 text-right tabular-nums" [class]="levelClass[level(r)]">{{ diff(r.diff_pct) }}</td>
                          <td class="py-2 pr-3 text-right tabular-nums" [attr.title]="sampleTitle(r.only_vps_sample)">{{ rows(r.only_vps_count) }}</td>
                          <td class="py-2 text-right tabular-nums" [attr.title]="sampleTitle(r.only_ref_sample)">{{ rows(r.only_ref_count) }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </section>
            }
          } @else {
            <p class="card text-sm text-muted" role="status" aria-live="polite">Chargement de la comparaison…</p>
          }
        }
      }

      <p class="text-xs text-muted">Outil de test interne, lecture seule, pas un conseil en investissement.</p>
    </main>
  `,
})
export class ShadowComparisonPage implements OnInit {
  protected readonly store = inject(ShadowComparisonStore);
  protected readonly windows = SHADOW_WINDOWS;
  protected readonly tables = SHADOW_TABLES;
  protected readonly tableLabel = SHADOW_TABLE_LABEL;
  protected readonly levelClass = LEVEL_CLASS;
  protected readonly acceptance = SHADOW_ACCEPTANCE;
  protected readonly acceptanceLabel = ACCEPTANCE_LABEL;
  protected readonly statusLabel = TABLE_STATUS_LABEL;
  protected readonly statusClass = STATUS_CLASS;
  protected readonly tolerance = toleranceLabel;
  protected readonly msg = SHADOW_MSG;
  protected readonly diff = formatDiff;
  protected readonly rows = formatRows;
  protected readonly day = formatDay;
  protected readonly level = dayLevel;

  protected readonly snapshotAt = computed(() => {
    const at = this.store.data()?.snapshot_at;
    return at ? SNAPSHOT_AT.format(Date.parse(at)) : null;
  });

  ngOnInit(): void {
    void this.store.load();
  }

  protected windowLabel(w: ShadowWindow): string {
    return w === 'snapshot' ? 'Instantané' : `${w} jours`;
  }

  protected selectWindow(w: ShadowWindow): void {
    this.store.selectWindow(w);
  }

  protected selectTable(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.store.selectTable((SHADOW_TABLES as readonly string[]).includes(value) ? (value as ShadowTable) : null);
  }

  protected sampleTitle(sample: readonly string[]): string | null {
    return sample.length > 0 ? sample.join(', ') : null;
  }
}
