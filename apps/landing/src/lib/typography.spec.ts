import { describe, expect, it } from 'vitest';
import { frenchSpacingHtml, splitInversions } from './typography';

describe('splitInversions', () => {
  it('protège les inversions sujet-verbe', () => {
    expect(splitInversions('Raijin me recommande-t-il des tokens ?')).toEqual([
      { text: 'Raijin me ', nowrap: false },
      { text: 'recommande-t-il', nowrap: true },
      { text: ' des tokens ?', nowrap: false },
    ]);
    expect(splitInversions('Un verdict Sain veut-il dire')[1]).toEqual({ text: 'veut-il', nowrap: true });
    expect(splitInversions('Puis-je coller un lien ?')[0]).toEqual({ text: 'Puis-je', nowrap: true });
  });

  it('laisse les autres traits d’union et le texte intact', () => {
    expect(splitInversions('anti-rug et pump.fun')).toEqual([{ text: 'anti-rug et pump.fun', nowrap: false }]);
    const text = "D'où viennent les données ? Existe-t-il un devis ?";
    expect(splitInversions(text).map((s) => s.text).join('')).toBe(text);
  });
});

describe('frenchSpacingHtml', () => {
  it('met une espace insécable avant : ; ? ! » et après « dans le texte du body', () => {
    const html = frenchSpacingHtml(
      '<html><head><title>A : b ?</title></head><body><p>Contact : <a href="mailto:a@b.fr">a@b.fr</a> (assistance : x) ; « Sain » ? Oui !</p></body></html>',
    );
    expect(html).toContain('<title>A : b ?</title>');
    expect(html).toContain('Contact\u00a0: <a href="mailto:a@b.fr">');
    expect(html).toContain('(assistance\u00a0: x)\u00a0; «\u00a0Sain\u00a0»\u00a0? Oui\u00a0!');
  });

  it('ne touche ni aux attributs, ni au code, ni au JSON-LD, ni aux URL', () => {
    const body =
      '<body><a title="a : b" href="https://x.fr/?q=1">https://x.fr</a><code>a : b</code><pre>x ; y</pre>' +
      '<script type="application/ld+json">{"name":"Mint authority : c\'est quoi ?"}</script><p>a:hover ?utm=1</p></body>';
    expect(frenchSpacingHtml(body)).toBe(body);
  });
});
