import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RjIcons, type IconNode, type RjIconName } from './icons';

/**
 * Icône Lucide : trait de 1,75 px, coins arrondis, `currentColor`, grille de 24 px (BRAND.md).
 * Décorative par défaut (`aria-hidden`) : le sens est porté par le texte voisin ou un `aria-label`.
 */
@Component({
  selector: 'rj-icon',
  template: `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      [attr.width]="size()"
      [attr.height]="size()"
      [class.animate-spin]="spin()"
      aria-hidden="true"
      focusable="false"
    >
      @for (node of nodes(); track $index) {
        @switch (node[0]) {
          @case ('path') {
            <svg:path [attr.d]="node[1]['d']" />
          }
          @case ('circle') {
            <svg:circle [attr.cx]="node[1]['cx']" [attr.cy]="node[1]['cy']" [attr.r]="node[1]['r']" />
          }
          @case ('rect') {
            <svg:rect
              [attr.x]="node[1]['x']"
              [attr.y]="node[1]['y']"
              [attr.width]="node[1]['width']"
              [attr.height]="node[1]['height']"
              [attr.rx]="node[1]['rx']"
              [attr.ry]="node[1]['ry']"
            />
          }
          @case ('line') {
            <svg:line
              [attr.x1]="node[1]['x1']"
              [attr.y1]="node[1]['y1']"
              [attr.x2]="node[1]['x2']"
              [attr.y2]="node[1]['y2']"
            />
          }
          @case ('polyline') {
            <svg:polyline [attr.points]="node[1]['points']" />
          }
          @case ('polygon') {
            <svg:polygon [attr.points]="node[1]['points']" />
          }
          @case ('ellipse') {
            <svg:ellipse
              [attr.cx]="node[1]['cx']"
              [attr.cy]="node[1]['cy']"
              [attr.rx]="node[1]['rx']"
              [attr.ry]="node[1]['ry']"
            />
          }
        }
      }
    </svg>
  `,
  host: { class: 'inline-flex shrink-0 items-center justify-center' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjIcon {
  /** Nom d'une icône de `RjIcons`, ou nœud Lucide brut. */
  readonly name = input.required<RjIconName | IconNode>();
  /** Taille en px (grille de 24 px ; 16, 20 ou 24 dans l'interface). */
  readonly size = input<16 | 20 | 24 | 32>(20);
  readonly spin = input(false);

  protected readonly nodes = computed<IconNode>(() => {
    const name = this.name();
    return typeof name === 'string' ? RjIcons[name] : name;
  });
}
