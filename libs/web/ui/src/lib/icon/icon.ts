import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, untracked } from '@angular/core';
import { RjIcons, type IconNode, type RjIconName } from './icons';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Attributs du trait Raijin (BRAND.md) : 1,75 px, coins arrondis, `currentColor`, grille de 24 px. */
const SVG_ATTRIBUTES: Readonly<Record<string, string>> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.75',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
  focusable: 'false',
};

/** Formes et attributs géométriques acceptés (données Lucide, aucun attribut libre). */
const SHAPE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  path: ['d'],
  circle: ['cx', 'cy', 'r'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
};

/** Modèle SVG par icône, construit une fois puis cloné (`cloneNode`) à chaque usage. */
const templates = new WeakMap<IconNode, SVGSVGElement>();

function iconTemplate(doc: Document, nodes: IconNode): SVGSVGElement {
  let svg = templates.get(nodes);
  if (!svg) {
    svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [name, value] of Object.entries(SVG_ATTRIBUTES)) svg.setAttribute(name, value);
    for (const [tag, attributes] of nodes) {
      const allowed = SHAPE_ATTRIBUTES[tag];
      if (!allowed) continue;
      const shape = doc.createElementNS(SVG_NS, tag);
      for (const name of allowed) {
        const value = (attributes as Record<string, string | number | undefined>)[name];
        if (value !== undefined && value !== null) shape.setAttribute(name, String(value));
      }
      svg.appendChild(shape);
    }
    templates.set(nodes, svg);
  }
  return svg;
}

/**
 * Icône Lucide : trait de 1,75 px, coins arrondis, `currentColor`, grille de 24 px (BRAND.md).
 * Décorative par défaut (`aria-hidden`) : le sens est porté par le texte voisin ou un `aria-label`.
 * Le SVG est cloné depuis un modèle par icône plutôt que rendu par un template (une vue par forme) :
 * les écrans affichent des dizaines d'icônes au premier rendu (docs/ARCHITECTURE.md §10).
 */
@Component({
  selector: 'rj-icon',
  template: '',
  host: { class: 'inline-flex shrink-0 items-center justify-center' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjIcon {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);
  private svg: SVGSVGElement | null = null;

  /** Nom d'une icône de `RjIcons`, ou nœud Lucide brut. */
  readonly name = input.required<RjIconName | IconNode>();
  /** Taille en px (grille de 24 px ; 16, 20 ou 24 dans l'interface). */
  readonly size = input<16 | 20 | 24 | 32>(20);
  readonly spin = input(false);

  protected readonly nodes = computed<IconNode>(() => {
    const name = this.name();
    return typeof name === 'string' ? RjIcons[name] : name;
  });

  constructor() {
    // Effet de composant : exécuté pendant la détection de changements, avant l'affichage.
    effect(() => {
      const svg = iconTemplate(this.document, this.nodes()).cloneNode(true) as SVGSVGElement;
      this.svg?.remove();
      this.svg = svg;
      untracked(() => this.applySize());
      this.host.appendChild(svg);
    });
    effect(() => this.applySize());
  }

  private applySize(): void {
    const size = String(this.size());
    const spin = this.spin();
    if (!this.svg) return;
    this.svg.setAttribute('width', size);
    this.svg.setAttribute('height', size);
    this.svg.classList.toggle('animate-spin', spin);
  }
}
