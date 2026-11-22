import { ChangeDetectionStrategy, Component } from '@angular/core';

let nextId = 0;

/**
 * Animation d'attente « éclair qui parcourt le bouclier » : un reflet jaune balaie le bouclier
 * de haut en bas pendant que l'éclair pulse. SVG + CSS, `transform` et `opacity` uniquement,
 * décorative (le texte d'état est porté par le parent). Mouvement réduit : bouclier fixe.
 */
@Component({
  selector: 'rj-shield-scan',
  template: `
    <svg viewBox="8 2 48 60" class="block h-full w-full" aria-hidden="true" focusable="false">
      <defs>
        <clipPath [attr.id]="clipId">
          <path d="M32 4 L54 11.5 V29 C54 43.5 45 53.5 32 60 C19 53.5 10 43.5 10 29 V11.5 Z" />
        </clipPath>
        <linearGradient [attr.id]="gradientId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="rj-stop-clear" />
          <stop offset="0.5" class="rj-stop-bright" />
          <stop offset="1" class="rj-stop-clear" />
        </linearGradient>
      </defs>
      <path
        class="fill-surface-raised stroke-line"
        stroke-width="1.5"
        d="M32 4 L54 11.5 V29 C54 43.5 45 53.5 32 60 C19 53.5 10 43.5 10 29 V11.5 Z"
      />
      <g [attr.clip-path]="'url(#' + clipId + ')'">
        <rect class="rj-sweep" x="8" y="-14" width="48" height="22" [attr.fill]="'url(#' + gradientId + ')'" />
      </g>
      <path class="rj-bolt fill-thunder" d="M36 13 L21 35 H30.5 L27 51 L43 27.5 H33.5 Z" />
    </svg>
  `,
  styles: `
    :host { display: block; }
    .rj-stop-clear { stop-color: var(--color-thunder); stop-opacity: 0; }
    .rj-stop-bright { stop-color: var(--color-thunder); stop-opacity: 0.45; }
    .rj-sweep { animation: rj-sweep 1.2s var(--ease-raijin) infinite; will-change: transform; }
    .rj-bolt { animation: rj-bolt 1.2s ease-in-out infinite; transform-origin: 32px 32px; }
    @keyframes rj-sweep {
      from { transform: translateY(0); }
      to { transform: translateY(70px); }
    }
    @keyframes rj-bolt {
      0%, 100% { opacity: 0.55; }
      50% { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .rj-sweep { animation: none; opacity: 0; }
      .rj-bolt { animation: none; opacity: 1; }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjShieldScan {
  protected readonly clipId = `rj-shield-clip-${nextId}`;
  protected readonly gradientId = `rj-shield-grad-${nextId++}`;
}
