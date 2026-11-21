import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { signedPctInt, sparklineGeometry } from '../utils/visuals';

const W = 100;
const H = 32;

/**
 * Decorative price sparkline (green if last ≥ first, red otherwise, low-opacity area). The SVG is
 * aria-hidden; the 6 h change is given as screen-reader text. Renders nothing without ≥ 2 points.
 * Size it from the host (e.g. `class="h-5 w-full"`).
 */
@Component({
  selector: 'app-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    @if (geo(); as g) {
      <svg
        aria-hidden="true"
        [attr.viewBox]="viewBox"
        preserveAspectRatio="none"
        class="block size-full overflow-visible"
        [class.text-bull]="g.up"
        [class.text-bear]="!g.up"
        [attr.data-trend]="g.up ? 'up' : 'down'"
      >
        <path [attr.d]="g.area" fill="currentColor" fill-opacity="0.12" stroke="none" data-spark-area />
        <polyline
          [attr.points]="g.points"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
          data-spark-line
        />
      </svg>
      <span class="sr-only" data-spark-sr>{{ srText() }}</span>
    }
  `,
})
export class Sparkline {
  readonly values = input<readonly number[] | null>(null);
  /** Prefix of the screen-reader text. */
  readonly label = input('Variation 6 h');

  protected readonly viewBox = `0 0 ${W} ${H}`;
  protected readonly geo = computed(() => sparklineGeometry(this.values(), W, H));
  protected readonly srText = computed(() => {
    const g = this.geo();
    return g ? `${this.label()} : ${signedPctInt(g.changePct)}` : '';
  });
}
