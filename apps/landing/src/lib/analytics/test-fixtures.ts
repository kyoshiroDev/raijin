import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Balisage réel de `ConsentBanner.astro` et `ManageCookiesButton.astro` (expressions Astro remplacées), pour que
 * les tests du script (lancés depuis apps/landing, comme la cible Nx)
 * portent sur les mêmes attributs que la page construite.
 */
function template(relative: string): string {
  const source = readFileSync(resolve(process.cwd(), 'src/components/consent', relative), 'utf8');
  return source.slice(source.indexOf('---', 3) + 3);
}

export function renderPage(doc: Document, measurementId: string | null, body = ''): void {
  const banner = measurementId
    ? template('ConsentBanner.astro')
        .replace('{measurementId}', `"${measurementId}"`)
        .replace(/class=\{`\$\{button\} ([^`]*)`\}/g, 'class="$1"')
        .replace(/class=\{button\}/g, 'class=""')
    : '';
  const manage = measurementId ? template('ManageCookiesButton.astro') : '';
  doc.head.innerHTML = '';
  doc.body.innerHTML = `${banner}<main>${body}</main><footer>${manage}</footer>`;
}

export function clearCookies(doc: Document): void {
  for (const part of doc.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name) doc.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

export function googleScripts(doc: Document): HTMLScriptElement[] {
  return [...doc.querySelectorAll<HTMLScriptElement>('script')].filter((s) => /google/.test(s.src));
}
