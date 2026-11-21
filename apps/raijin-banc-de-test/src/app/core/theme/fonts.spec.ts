import { describe, expect, it } from 'vitest';
import indexHtml from '../../../index.html' with { loader: 'text' };
import stylesCss from '../../../styles.css' with { loader: 'text' };

const FONT_URL = '/fonts/inter-latin-wght-normal.woff2';
const fontFaces = stylesCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];

describe("self-hosted UI font (CSP font-src 'self')", () => {
  it('declares exactly one Inter Variable @font-face, served from /fonts on the same origin, with font-display: swap', () => {
    expect(fontFaces).toHaveLength(1);
    const face = fontFaces[0] ?? '';
    expect(face).toContain('font-family: "Inter Variable"');
    expect(face).toContain('font-display: swap');
    expect(face).toMatch(/font-weight:\s*100 900/);
    const urls = Array.from(face.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g), (m) => m[1]);
    expect(urls).toEqual([FONT_URL]);
    expect(face).toContain('format("woff2")');
  });

  it('never loads a font or stylesheet from another origin', () => {
    for (const text of [stylesCss, indexHtml]) {
      expect(text).not.toMatch(/fonts\.googleapis|fonts\.gstatic|jsdelivr|unpkg|cdnjs/i);
    }
    expect(stylesCss).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
    expect(stylesCss).not.toMatch(/@import\s+(url\()?["']?https?:/i);
  });

  it('puts Inter first in --font-sans, with a system fallback', () => {
    const sans = /--font-sans:\s*([^;]+);/.exec(stylesCss)?.[1] ?? '';
    expect(sans.startsWith('"Inter Variable"')).toBe(true);
    expect(sans).toContain('system-ui');
  });

  it('preloads the same file in index.html (as=font, woff2, crossorigin so the preload is reused)', () => {
    const preload = /<link[^>]+rel="preload"[^>]*>/.exec(indexHtml)?.[0] ?? '';
    expect(preload).toContain(`href="${FONT_URL}"`);
    expect(preload).toContain('as="font"');
    expect(preload).toContain('type="font/woff2"');
    expect(preload).toMatch(/\scrossorigin[\s>=]/);
  });

  it('defines the type scale and the glow / elevation tokens in @theme', () => {
    for (const token of ['--text-micro:', '--text-label:', '--text-value:', '--shadow-glow:', '--color-surface-3:', '--color-line-strong:']) {
      expect(stylesCss).toContain(token);
    }
  });

  it('keeps every motion of the identity behind prefers-reduced-motion', () => {
    expect(stylesCss).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.skeleton/);
    expect(stylesCss).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.card-glow::after/);
    expect(stylesCss).toMatch(/@utility press \{\s*@media \(prefers-reduced-motion: no-preference\)/);
  });
});
