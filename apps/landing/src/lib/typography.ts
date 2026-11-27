/**
 * Découpe un texte pour empêcher la césure sur le trait d'union des inversions (« veut-il », « recommande-t-il »,
 * « Puis-je ») : les segments `nowrap` sont rendus dans un `<span class="whitespace-nowrap">`. Le texte d'origine
 * (et donc le JSON-LD) reste inchangé.
 */
export interface TextSegment {
  text: string;
  nowrap: boolean;
}

const INVERSION = /[\p{L}']+-(?:t-)?(?:il|elle|on|ils|elles|je|tu|nous|vous|ce)(?![\p{L}-])/giu;

export function splitInversions(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(INVERSION)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: text.slice(last, start), nowrap: false });
    segments.push({ text: match[0], nowrap: true });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), nowrap: false });
  return segments;
}

/**
 * Typographie française du HTML construit : espace insécable (U+00A0) avant `:` `;` `?` `!` et `»`, après `«`,
 * pour qu'aucune ponctuation ne commence une ligne (« assistance : » coupé avant les deux-points à 390 px).
 * Seul le texte du `<body>` est touché : ni les attributs, ni `<head>` (title, meta), ni le contenu de `script`
 * (JSON-LD), `style`, `pre`, `code`, `kbd`, `samp`, `textarea` et `svg`. Une ponctuation collée à un mot ou suivie
 * d'une lettre (`https:`, `a:hover`, `?utm=`) n'est jamais modifiée. Appliqué par l'intégration du build
 * (`astro.config.mjs`), sans aucun JS côté client.
 */
const NBSP = '\u00a0';
const RAW_TEXT = new Set(['script', 'style', 'pre', 'code', 'kbd', 'samp', 'textarea', 'svg']);
/** Balise, commentaire ou doctype ; les valeurs d'attribut entre guillemets peuvent contenir `>`. */
const TAG = /<!--[\s\S]*?-->|<!?\/?[a-zA-Z][^\s/>]*(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const BEFORE_PUNCT = /[ \t\r\n]+(?=(?:[:;?!]+|»)(?:[\s\u00a0)\].,…»]|$))/g;
const AFTER_GUILLEMET = /«[ \t\r\n]+/g;

export function frenchSpacingText(text: string): string {
  return text.replace(BEFORE_PUNCT, NBSP).replace(AFTER_GUILLEMET, `«${NBSP}`);
}

export function frenchSpacingHtml(html: string): string {
  const bodyStart = html.search(/<body[\s>]/i);
  if (bodyStart < 0) return html;
  const body = html.slice(bodyStart);
  const parts: string[] = [html.slice(0, bodyStart)];
  let skip: string | null = null;
  let cursor = 0;
  for (const match of body.matchAll(TAG)) {
    const text = body.slice(cursor, match.index);
    parts.push(skip ? text : frenchSpacingText(text), match[0]);
    cursor = match.index + match[0].length;
    const name = /^<\/?([a-zA-Z][^\s/>]*)/.exec(match[0])?.[1]?.toLowerCase();
    if (!name) continue;
    const closing = match[0].startsWith('</');
    if (skip) {
      if (closing && name === skip) skip = null;
    } else if (!closing && RAW_TEXT.has(name) && !match[0].endsWith('/>')) {
      skip = name;
    }
  }
  const tail = body.slice(cursor);
  parts.push(skip ? tail : frenchSpacingText(tail));
  return parts.join('');
}
