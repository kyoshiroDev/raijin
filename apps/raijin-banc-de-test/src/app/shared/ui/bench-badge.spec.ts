import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import indexHtml from '../../../index.html' with { loader: 'text' };
import stylesCss from '../../../styles.css' with { loader: 'text' };
import robotsTxt from '../../../../public/robots.txt' with { loader: 'text' };
import manifestText from '../../../../public/manifest.webmanifest' with { loader: 'text' };
import { BenchBadge } from './bench-badge';
import { PageHeader } from './page-header';

/** Valeur du token `warn` de libs/brand/tokens.css (charte Raijin). */
const BRAND_WARN = '#f59e0b';

describe('BenchBadge', () => {
  it('affiche « BANC DE TEST » en couleur warn, avec un libellé accessible', () => {
    const fixture = TestBed.createComponent(BenchBadge);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent?.trim()).toBe('BANC DE TEST');
    expect(el.className).toContain('text-warn');
    expect(el.getAttribute('aria-label')).toContain('Banc de test');
  });

  it('est présent dans chaque en-tête de page', () => {
    const fixture = TestBed.createComponent(PageHeader);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="bench-badge"]')?.textContent?.trim()).toBe('BANC DE TEST');
  });

  it('utilise la même valeur warn que la charte libs/brand', () => {
    const warn = /--color-warn:\s*([^;]+);/.exec(stylesCss)?.[1]?.trim();
    expect(warn).toBe(BRAND_WARN);
  });
});

describe('Raijin-banc-de-test : jamais indexé, jamais confondu avec Raijin', () => {
  it('porte le titre Raijin-banc-de-test et une meta robots noindex, nofollow', () => {
    expect(indexHtml).toContain('<title>Raijin-banc-de-test</title>');
    expect(indexHtml).toMatch(/<meta name="robots" content="noindex, nofollow[^"]*">/);
  });

  it('sert un robots.txt qui interdit tout', () => {
    expect(robotsTxt).toMatch(/User-agent:\s*\*/);
    expect(robotsTxt).toMatch(/^Disallow:\s*\/\s*$/m);
  });

  it("n'utilise pas la mascotte", () => {
    for (const text of [indexHtml, manifestText]) expect(text.toLowerCase()).not.toContain('mascot');
  });
});
