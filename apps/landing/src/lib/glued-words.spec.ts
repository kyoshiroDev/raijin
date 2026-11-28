import { describe, expect, it } from 'vitest';
import { findGluedWords } from './glued-words';

const page = (body: string) => `<!doctype html><html lang="fr"><head><title>T : x</title></head><body>${body}</body></html>`;

describe('findGluedWords', () => {
  it('détecte les mots collés du tour 7 (CGU, confidentialité, comment ça marche)', () => {
    const cases = [
      '<p>Saint-Michel-sur-Orge, France(voir les <a href="/mentions-legales">mentions légales</a>)</p>',
      '<p>à l\'adresse de contact :<a href="mailto:contact@raijinshield.com">contact@raijinshield.com</a>.</p>',
      '<p>(voir les<a href="/mentions-legales">mentions légales</a>)</p>',
      '<p>repérer un rug pull</a>,<a href="/guides/mint-authority">comprendre la mint authority</a>et <a href="/x">y</a></p>',
      '<p>médiateur de la consommation :<mark data-legal-todo>À compléter</mark>.</p>',
    ];
    for (const body of cases) expect(findGluedWords(page(body)), body).not.toEqual([]);
  });

  it('accepte un texte correct, les URL, les adresses, le code et les scripts', () => {
    const body = [
      '<p>Contact&nbsp;: <a href="mailto:contact@raijinshield.com">contact@raijinshield.com</a> (assistance&nbsp;: <a href="mailto:s@x.fr">s@x.fr</a>).</p>',
      '<p>Réclamation auprès de la CNIL (<a href="https://www.cnil.fr">cnil.fr</a>), voir https://raijinshield.com/tarifs.</p>',
      '<p>Le ou les token(s) ; <strong>Source</strong>&nbsp;: Helius.</p>',
      '<pre><code>getAccount(mint);a:b</code></pre><script type="application/ld+json">{"a":"b(c"}</script>',
      '<svg><text>x(y</text></svg><span class="tabular">14,90 €</span><span class="ml-1">par mois</span>',
    ].join('');
    expect(findGluedWords(page(body))).toEqual([]);
  });
});
