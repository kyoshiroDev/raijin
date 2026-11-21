import { ChangeDetectionStrategy, Component, InjectionToken, computed, inject, input } from '@angular/core';

/** Dossier public où l'app sert libs/brand (voir apps/web/project.json, assets). */
export const RJ_BRAND_ASSETS = new InjectionToken<string>('RJ_BRAND_ASSETS', {
  providedIn: 'root',
  factory: () => 'brand',
});

export type RjMascotPose = 'hero' | 'alerte' | 'bravo';

const SIZES = { sm: 64, md: 96, lg: 128 } as const;

/** Rai, le gardien : une apparition par écran maximum, jamais à la place d'un verdict. */
@Component({
  selector: 'rj-mascot',
  template: `<img [src]="src()" [width]="px()" [height]="pxHeight()" [alt]="alt()" decoding="async" class="block h-auto max-w-full" />`,
  host: { class: 'inline-block shrink-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjMascot {
  private readonly base = inject(RJ_BRAND_ASSETS);

  readonly pose = input.required<RjMascotPose>();
  readonly size = input<keyof typeof SIZES>('md');
  /** Vide par défaut : décoratif quand le texte voisin porte le message. */
  readonly alt = input('');

  protected readonly src = computed(() => `${this.base}/mascot/rai-${this.pose()}.svg`);
  protected readonly px = computed(() => SIZES[this.size()]);
  // Les poses sont dessinées en 240 × 280.
  protected readonly pxHeight = computed(() => Math.round((SIZES[this.size()] * 280) / 240));
}
