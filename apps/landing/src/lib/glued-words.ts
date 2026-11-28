/**
 * Détection des mots collés dans le HTML construit : la compression HTML d'Astro supprime l'espace d'un saut de
 * ligne voisin d'une expression `{…}` ou d'une balise (« France(voir », « les<a>mentions », « :<a>contact@ »).
 * Utilisé par `dist.spec.ts` sur chaque page. Le code, les scripts, les styles et le SVG sont ignorés ; les URL et
 * les adresses ne déclenchent rien (`https://`, `contact@raijinshield.com`, `cnil.fr`).
 */
const IGNORED = /<(script|style|pre|code|kbd|samp|textarea|svg)\b[\s\S]*?<\/\1>/gi;
/** Balises de texte (pas les `span` de mise en page, séparés visuellement par flex ou marges). */
const INLINE = '(?:a|strong|em|b|i|mark|abbr|cite|q|time)';

export const GLUED_PATTERNS: readonly { name: string; html: RegExp }[] = [
  { name: 'lettre ou ponctuation collée avant une balise de texte', html: new RegExp(`[\\p{L}\\p{N},;:.!?)»]<${INLINE}[\\s>]`, 'u') },
  { name: 'balise de texte fermée collée à un mot', html: new RegExp(`</${INLINE}>[\\p{L}\\p{N}(«]`, 'u') },
];

export const GLUED_TEXT: readonly { name: string; text: RegExp }[] = [
  { name: 'mot collé à une parenthèse ouvrante', text: /\p{L}\((?!s\))/u },
  { name: 'deux-points ou point-virgule collé au mot suivant', text: /(?<![\p{L}\p{N}/])[:;]\p{L}/u },
  { name: 'deux-points collé à une adresse e-mail', text: /:[^\s\u00a0/]+@/u },
];

/** Texte visible approché : balises de texte retirées sans espace, autres balises remplacées par une espace. */
export function visibleTextOf(html: string): string {
  return html
    .replace(IGNORED, ' ')
    .replace(new RegExp(`</?${INLINE}\\b[^>]*>`, 'g'), '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, '\u00a0');
}

/** Extraits fautifs (vide si aucun mot collé). */
export function findGluedWords(html: string): string[] {
  const body = html.slice(Math.max(0, html.search(/<body[\s>]/i))).replace(IGNORED, ' ');
  const found: string[] = [];
  const excerpt = (source: string, index: number) => source.slice(Math.max(0, index - 30), index + 30);
  for (const { name, html: pattern } of GLUED_PATTERNS) {
    for (const match of body.matchAll(new RegExp(pattern.source, 'gu'))) found.push(`${name} : ${excerpt(body, match.index)}`);
  }
  const text = visibleTextOf(body);
  for (const { name, text: pattern } of GLUED_TEXT) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'gu'))) found.push(`${name} : ${excerpt(text, match.index)}`);
  }
  return found;
}
