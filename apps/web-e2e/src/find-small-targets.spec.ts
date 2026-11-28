import { expect, test } from '@playwright/test';
import { findSmallTargets, MIN_TARGET } from './support/pages';

/**
 * Test unitaire du helper `findSmallTargets` (support/pages.ts) : exception WCAG 2.5.8 « inline » limitée aux liens
 * qui font partie d'une phrase ; tout autre lien ou bouton reste soumis aux 44 px. Page construite en mémoire.
 */
const STYLE = '<style>body{margin:0;font:16px/1.2 sans-serif} a,button{font-size:16px}</style>';

test.describe('findSmallTargets : exception « inline » stricte', () => {
  test('lien dans une phrase (p, li, td, dd, figcaption) : exempté', async ({ page }) => {
    await page.setContent(`${STYLE}
      <p>Lis le guide <a href="/a">rug pull</a> avant de signer.</p>
      <ul><li>Voir aussi <a href="/b">mint authority</a>.</li></ul>
      <table><tr><td>Source : <a href="/c">cnil.fr</a></td></tr></table>
      <dl><dd>Détail sur <a href="/d">honeypot</a></dd></dl>
      <figure><figcaption>Capture de <a href="/e">Solscan</a></figcaption></figure>`);
    expect(await findSmallTargets(page, MIN_TARGET)).toEqual([]);
  });

  test('lien seul dans un li, lien hors bloc de texte, bouton, lien entouré de liens ou de séparateurs : signalés', async ({ page }) => {
    await page.setContent(`${STYLE}
      <nav><ul><li><a href="/nav">Tarifs</a></li></ul></nav>
      <div>Texte <a href="/div">dans un div</a></div>
      <p>Un <button type="button">bouton</button> dans une phrase.</p>
      <li><a href="/x">Un</a> <a href="/y">Deux</a></li>
      <li><span aria-hidden="true">/</span> <a href="/z">Fil</a></li>
      <p><strong><a href="/w">Lien imbriqué</a></strong> et du texte.</p>`);
    const labels = (await findSmallTargets(page, MIN_TARGET)).map((issue) => issue.label);
    expect(labels).toEqual([
      '<a> « Tarifs »',
      '<a> « dans un div »',
      '<button> « bouton »',
      '<a> « Un »',
      '<a> « Deux »',
      '<a> « Fil »',
      '<a> « Lien imbriqué »',
    ]);
  });
});
