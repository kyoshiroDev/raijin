import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RUN_STATUS_CLASS, RUN_STATUS_LABEL, TRIGGER_LABEL, type BacktestRun, formatInt, formatLabDate, formatShare, resolutionText } from '@raijin/bench-web-logic/strategy-lab';
import type { LabFeedback } from '../strategy-lab-store';

interface Fact {
  key: string;
  label: string;
  value: string;
}

/**
 * Latest backtest run: status, dates, data volume, train / test cutoff and candle resolutions, plus the
 * « Relancer le backtest » and « Actualiser » actions (presentational). lab-v2 runs also report their events and
 * the events still waiting for candles. The facts describe the last FINISHED run
 * (the one whose results are listed); the status line describes the most recent run.
 */
@Component({
  selector: 'app-lab-run-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-3 p-3', 'data-lab-run': '' },
  template: `
    @if (latest(); as run) {
      <div class="flex flex-wrap items-center gap-2">
        <span class="pill" [class]="statusClass[run.status]" data-run-status>{{ statusLabel[run.status] }}</span>
        <span class="text-xs text-muted">
          Lancé le {{ date(run.startedAt ?? run.createdAt) }}@if (run.trigger) { · {{ triggerLabel[run.trigger] }} }
        </span>
      </div>
      @if (run.status === 'running' && progressText()) {
        <div class="space-y-1" data-run-progress>
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
            <div class="h-full rounded-full bg-info" [style.width.%]="(run.progress ?? 0) * 100"></div>
          </div>
          <p class="text-label text-muted" role="status">Progression : {{ progressText() }}</p>
        </div>
      }
      @if (run.status === 'failed') {
        <p class="text-xs text-bear" data-run-failed>Le dernier backtest a échoué. Les résultats affichés sont ceux du dernier backtest terminé.</p>
      }
    }
    @if (lastDone(); as done) {
      <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-xs tabular-nums slashed-zero">
        @for (f of facts(); track f.key) {
          <div class="min-w-0" [attr.data-fact]="f.key">
            <dt class="text-label text-muted">{{ f.label }}</dt>
            <dd class="font-semibold">{{ f.value }}</dd>
          </div>
        }
      </dl>
      <p class="text-label text-muted" data-resolutions>{{ resolutions(done.data) }}</p>
      @if (pendingText(); as pending) {
        <p class="text-label text-warn" data-pending-candles>{{ pending }}</p>
      }
    } @else {
      <p class="text-sm text-muted" data-no-done-run>Aucun backtest terminé pour l’instant.</p>
    }
    <div class="grid grid-cols-[1fr_auto] gap-2">
      <button type="button" class="btn-primary" [disabled]="!canRequest()" (click)="request.emit()" data-request-run>
        {{ requesting() ? 'Envoi…' : running() ? 'Backtest en cours…' : 'Relancer le backtest' }}
      </button>
      <button type="button" class="btn-ghost" [disabled]="refreshing()" (click)="refresh.emit()" data-refresh>Actualiser</button>
    </div>
    @if (feedback(); as f) {
      <p class="text-sm" [class.text-bear]="f.kind === 'error'" [class.text-bull]="f.kind === 'ok'" [attr.role]="f.kind === 'error' ? 'alert' : 'status'" data-lab-feedback>
        {{ f.text }}
      </p>
    }
  `,
})
export class LabRunCard {
  readonly latest = input<BacktestRun | null>(null);
  readonly lastDone = input<BacktestRun | null>(null);
  readonly running = input(false);
  readonly canRequest = input(false);
  readonly requesting = input(false);
  readonly refreshing = input(false);
  readonly feedback = input<LabFeedback | null>(null);
  readonly request = output();
  readonly refresh = output();

  protected readonly statusLabel = RUN_STATUS_LABEL;
  protected readonly statusClass = RUN_STATUS_CLASS;
  protected readonly triggerLabel = TRIGGER_LABEL;
  protected readonly date = formatLabDate;
  protected readonly resolutions = resolutionText;

  protected readonly progressText = computed(() => {
    const p = this.latest()?.progress;
    return p == null ? '' : formatShare(p);
  });

  /** « 12 événements en attente de bougies (non simulés pour l’instant). » when the run reports some. */
  protected readonly pendingText = computed(() => {
    const n = this.lastDone()?.data.pendingCandles ?? null;
    if (n === null || n === 0) return '';
    return `${formatInt(n)} événement${n > 1 ? 's' : ''} en attente de bougies (non simulé${n > 1 ? 's' : ''} pour l’instant).`;
  });

  protected readonly facts = computed<Fact[]>(() => {
    const run = this.lastDone();
    if (!run) return [];
    return [
      { key: 'finished', label: 'Terminé le', value: formatLabDate(run.finishedAt ?? run.createdAt) },
      { key: 'detections', label: 'Détections', value: formatInt(run.nDetections ?? run.data.detections) },
      ...(run.data.events === null ? [] : [{ key: 'events', label: 'Événements', value: formatInt(run.data.events) }]),
      { key: 'variants', label: 'Variantes testées', value: formatInt(run.nVariants) },
      { key: 'distinct', label: 'Variantes distinctes', value: formatInt(run.nDistinctVariants) },
      { key: 'cutoff', label: 'Coupure apprentissage / test', value: formatLabDate(run.data.cutoff) },
      { key: 'max', label: 'Détection la plus récente', value: formatLabDate(run.data.maxDetectedAt) },
    ];
  });
}
