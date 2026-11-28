/**
 * Enveloppe chaque `<table>` du HTML rendu des guides dans
 * `<div class="table-scroll" role="region" tabindex="0" aria-label="…">` : une région défilante atteignable au clavier
 * (axe `scrollable-region-focusable`, WCAG 2.1.1). Le nom reprend les en-têtes de la première ligne.
 * Transformation de chaîne sur le HTML produit au build depuis nos propres fichiers Markdown (aucune donnée externe),
 * sans dépendance : le processeur Markdown d'Astro 7 n'accepte plus les plugins rehype sans `@astrojs/markdown-remark`.
 */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Nom accessible d'un tableau : « Tableau : en-tête 1, en-tête 2… ». */
export function tableLabel(tableHtml: string): string {
  const row = /<tr[^>]*>([\s\S]*?)<\/tr>/i.exec(tableHtml)?.[1] ?? '';
  const names = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map((cell) => decodeBasicEntities((cell[1] ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return names.length > 0 ? `Tableau : ${names.join(', ')}` : 'Tableau';
}

export function wrapTables(html: string): string {
  return html.replace(/<table[\s>][\s\S]*?<\/table>/gi, (table) => {
    const label = escapeAttribute(tableLabel(table));
    return `<div class="table-scroll" role="region" tabindex="0" aria-label="${label}">${table}</div>`;
  });
}
