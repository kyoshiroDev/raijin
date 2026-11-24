import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import {
  CHART_HEIGHT,
  buildChartGeometry,
  formatParisTime,
  formatPriceFr,
  nearestIndex,
  type ChartMarker,
  type LabelTone,
  type PricePoint,
} from './price-chart-data';

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 240;
const TOOLTIP_WIDTH = 112;

const LABEL_CLASS: Record<LabelTone, string> = {
  current: 'fill-fg font-bold',
};

/**
 * Inline SVG price chart (presentational): line + area, markers, current price label. Scrub with a finger / mouse (pointer events) or the arrow keys when focused.
 * Renders no hostile text: only numbers and fixed labels; the summary is bound as an attribute.
 */
@Component({
  selector: 'app-price-chart-plot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative block' },
  template: `
    @if (geometry(); as g) {
      <div
        tabindex="0"
        role="img"
        data-chart-surface
        class="block touch-pan-y rounded-lg select-none"
        [attr.aria-label]="summary()"
        (keydown)="onKey($event)"
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp()"
        (pointerleave)="onPointerLeave($event)"
        (pointercancel)="clearScrub()"
      >
        <svg aria-hidden="true" focusable="false" class="block h-[200px] w-full" [attr.viewBox]="'0 0 ' + g.width + ' ' + g.height">
          <line x1="0" [attr.x2]="g.plotRight" [attr.y1]="g.plotBottom" [attr.y2]="g.plotBottom" class="stroke-line" stroke-width="1" />
          <path [attr.d]="g.area" class="fill-fg/5" />
          <path data-price-line [attr.d]="g.line" class="fill-none stroke-fg" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />
          @for (m of g.markers; track $index) {
            <g [attr.data-marker]="m.kind" [attr.transform]="'translate(' + m.x + ' ' + m.y + ')'" class="stroke-base" stroke-width="1">
              @switch (m.kind) {
                @case ('alert') { <path class="fill-info" d="M0 -6a3.2 3.2 0 0 1 3.2 3.2V0l1.6 2H-4.8L-3.2 0v-2.8A3.2 3.2 0 0 1 0 -6ZM-1.4 3a1.4 1.4 0 0 0 2.8 0Z" /> }
                @case ('fill') { <path class="fill-bull" d="M0 -5L4.5 3.5H-4.5Z" /> }
                @default { <path class="fill-warn" d="M0 5L4.5 -3.5H-4.5Z" /> }
              }
            </g>
          }
          <circle data-current-dot [attr.cx]="g.dot.x" [attr.cy]="g.dot.y" r="3.5" class="fill-fg stroke-base" stroke-width="1.5" />
          @for (lb of g.labels; track lb.id) {
            <text [attr.data-label]="lb.id" [attr.x]="g.plotRight + 6" [attr.y]="lb.y" dominant-baseline="middle" [attr.class]="'text-micro font-semibold tabular-nums slashed-zero ' + labelClass[lb.tone]">{{ lb.text }}</text>
          }
          @for (tk of g.ticks; track tk.x) {
            <text data-tick [attr.x]="tk.x" [attr.y]="g.height - 4" text-anchor="middle" class="fill-muted text-micro tabular-nums slashed-zero">{{ tk.label }}</text>
          }
          @if (scrubPoint(); as s) {
            <g data-crosshair class="stroke-muted" stroke-width="1">
              <line [attr.x1]="s.x" [attr.x2]="s.x" [attr.y1]="g.plotTop" [attr.y2]="g.plotBottom" stroke-dasharray="2 2" />
              <line x1="0" [attr.x2]="g.plotRight" [attr.y1]="s.y" [attr.y2]="s.y" stroke-dasharray="2 2" />
              <circle [attr.cx]="s.x" [attr.cy]="s.y" r="4" class="fill-fg stroke-base" stroke-width="1.5" />
            </g>
          }
        </svg>
      </div>
      @if (scrubPoint(); as s) {
        <div data-tooltip aria-hidden="true" class="pointer-events-none absolute top-0 rounded-lg border border-line bg-surface-2 px-2 py-1 text-center text-label leading-tight tabular-nums slashed-zero" [style.left.px]="s.left" [style.width.px]="tooltipWidth">
          <span class="block text-muted">{{ s.time }}</span>
          <span class="block font-semibold">{{ s.price }} $</span>
        </div>
      }
      <p class="sr-only" aria-live="polite" data-scrub-live>{{ scrubText() }}</p>
    }
  `,
})
export class PriceChartPlot {
  readonly points = input.required<readonly PricePoint[]>();
  readonly markers = input<readonly ChartMarker[]>([]);
  /** aria-label of the chart (see chartSummary). */
  readonly summary = input.required<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly width = signal(DEFAULT_WIDTH);
  protected readonly labelClass = LABEL_CLASS;
  protected readonly tooltipWidth = TOOLTIP_WIDTH;
  private pressed = false;

  protected readonly geometry = computed(() => buildChartGeometry(this.points(), this.markers(), this.width(), CHART_HEIGHT));

  /** Index of the scrubbed point (null = no crosshair); reset when the series changes (range toggle). */
  readonly scrubIndex = linkedSignal<readonly PricePoint[], number | null>({ source: this.points, computation: () => null });

  protected readonly scrubPoint = computed(() => {
    const g = this.geometry();
    const i = this.scrubIndex();
    const p = i === null ? undefined : this.points()[i];
    if (!g || i === null || !p) return null;
    const x = g.xs[i];
    return {
      x,
      y: g.ys[i],
      left: Math.round(Math.min(Math.max(0, x! - TOOLTIP_WIDTH / 2), Math.max(0, g.width - TOOLTIP_WIDTH))),
      time: formatParisTime(p.t),
      price: formatPriceFr(p.price),
    };
  });

  protected readonly scrubText = computed(() => {
    const s = this.scrubPoint();
    return s ? `${s.time} : ${s.price} $` : '';
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.host.nativeElement;
      const measure = (w: number) => {
        if (w > 0) this.width.set(Math.max(MIN_WIDTH, Math.round(w)));
      };
      measure(el.clientWidth);
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width ?? 0));
      observer.observe(el);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  protected onKey(event: KeyboardEvent): void {
    const last = this.points().length - 1;
    if (last < 0) return;
    const current = this.scrubIndex();
    let next: number | null;
    switch (event.key) {
      case 'ArrowLeft':
        next = current === null ? last : Math.max(0, current - 1);
        break;
      case 'ArrowRight':
        next = current === null ? last : Math.min(last, current + 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'Escape':
        if (current === null) return;
        next = null;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.scrubIndex.set(next);
  }

  protected onPointerDown(event: PointerEvent): void {
    this.pressed = true;
    const target = event.currentTarget;
    if (target instanceof Element && typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Capture is a nicety (keeps the scrub while the finger leaves the chart).
      }
    }
    this.scrubAt(event);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (this.pressed || event.pointerType === 'mouse') this.scrubAt(event);
  }

  protected onPointerUp(): void {
    this.pressed = false;
  }

  protected onPointerLeave(event: PointerEvent): void {
    this.pressed = false;
    if (event.pointerType === 'mouse') this.clearScrub();
  }

  clearScrub(): void {
    this.pressed = false;
    this.scrubIndex.set(null);
  }

  private scrubAt(event: PointerEvent): void {
    const g = this.geometry();
    const target = event.currentTarget;
    if (!g || !(target instanceof Element)) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = ((event.clientX - rect.left) * g.width) / rect.width;
    const i = nearestIndex(g.xs, x);
    if (i >= 0) this.scrubIndex.set(i);
  }
}
