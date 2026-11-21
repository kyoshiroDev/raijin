import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Logo Raijin Shield, dessiné en ligne (le texte hérite de Space Grotesk chargée par la page,
 * ce qu'un `<img>` SVG ne permet pas). `auto` : symbole seul sous 360 px, logotype au-delà.
 * Géométrie reprise de libs/brand/logos/raijin-wordmark-color.svg ; couleurs = tokens.
 */
@Component({
  selector: 'rj-logo',
  template: `
    @if (variant() !== 'wordmark') {
      <svg
        viewBox="8 2 48 60"
        [class]="markClass()"
        role="img"
        aria-label="Raijin Shield"
      >
        <path class="fill-thunder" d="M32 4 L54 11.5 V29 C54 43.5 45 53.5 32 60 C19 53.5 10 43.5 10 29 V11.5 Z" />
        <path class="fill-base" d="M36 13 L21 35 H30.5 L27 51 L43 27.5 H33.5 Z" />
      </svg>
    }
    @if (variant() !== 'mark') {
      <svg
        viewBox="8 2 204 60"
        [class]="wordmarkClass()"
        role="img"
        aria-label="Raijin Shield"
      >
        <path class="fill-thunder" d="M32 4 L54 11.5 V29 C54 43.5 45 53.5 32 60 C19 53.5 10 43.5 10 29 V11.5 Z" />
        <path class="fill-base" d="M36 13 L21 35 H30.5 L27 51 L43 27.5 H33.5 Z" />
        <text x="70" y="38" class="fill-ink font-display" font-size="36" font-weight="700" letter-spacing="-1">Raijin</text>
        <text x="72" y="56" class="fill-thunder font-display" font-size="12" font-weight="600" letter-spacing="5.2">SHIELD</text>
      </svg>
    }
  `,
  host: { class: 'inline-flex items-center' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjLogo {
  readonly variant = input<'auto' | 'wordmark' | 'mark'>('auto');

  protected readonly markClass = computed(() => (this.variant() === 'auto' ? 'h-8 w-auto xs:hidden' : 'h-8 w-auto'));
  protected readonly wordmarkClass = computed(() =>
    this.variant() === 'auto' ? 'hidden h-8 w-auto xs:block' : 'h-8 w-auto',
  );
}
