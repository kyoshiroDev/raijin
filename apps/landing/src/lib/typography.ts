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
