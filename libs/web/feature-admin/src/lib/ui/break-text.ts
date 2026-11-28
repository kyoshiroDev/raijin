import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Séparateurs après lesquels une URL, un chemin ou un e-mail peut passer à la ligne. */
const BREAK_AFTER = /([/.\-@?&=_#])/;

/**
 * Découpe un texte en segments qui se terminent par un séparateur (`/`, `.`, `-`, `@`, `?`, `&`, `=`, `_`, `#`).
 * La concaténation des segments redonne le texte exact : aucun caractère perdu.
 */
export function breakSegments(text: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (const part of text.split(BREAK_AFTER)) {
    if (part === '') continue;
    current += part;
    if (BREAK_AFTER.test(part) && part.length === 1) {
      segments.push(current);
      current = '';
    }
  }
  if (current !== '') segments.push(current);
  return segments;
}

/**
 * Texte long sans espaces (URL, chemin, e-mail) qui passe à la ligne seulement après ses séparateurs : un `<wbr>`
 * est inséré après chacun. À placer dans un parent `wrap-break-word` (`overflow-wrap: break-word`), qui ne coupe
 * un segment en plein mot qu'en tout dernier recours (segment plus large que la colonne). Jamais tronqué.
 *
 * `<span class="wrap-break-word"><rj-break-text [text]="row.path" /></span>`
 */
@Component({
  selector: 'rj-break-text',
  // Aucun espace dans le modèle : il s'ajouterait au texte affiché.
  template: `@for (segment of segments(); track $index) {<span>{{ segment }}</span><wbr />}`,
  host: { 'data-rj-break-text': '' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjBreakText {
  readonly text = input.required<string>();
  protected readonly segments = computed(() => breakSegments(this.text()));
}
