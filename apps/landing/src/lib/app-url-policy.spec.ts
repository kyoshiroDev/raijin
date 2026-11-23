import { describe, expect, it } from 'vitest';
import { assertAllowedAppUrl, isAllowedAppUrl } from './app-url-policy';
import { tableLabel, wrapTables } from './scrollable-tables';

describe('APP_URL', () => {
  it.each(['https://app.raijinshield.com', 'https://app.raijinshield.com/', 'http://127.0.0.1:4310', 'http://localhost:4200'])(
    'accepte %s',
    (value) => expect(isAllowedAppUrl(value)).toBe(true),
  );

  it.each([
    'http://app.raijinshield.com',
    'javascript:alert(1)',
    'ftp://app.raijinshield.com',
    'https://user:pass@app.raijinshield.com',
    'https://app.raijinshield.com/?x=1',
    'https://app.raijinshield.com/#x',
    'app.raijinshield.com',
    '',
  ])('refuse %s', (value) => {
    expect(isAllowedAppUrl(value)).toBe(false);
    expect(() => assertAllowedAppUrl(value)).toThrow(/APP_URL invalide/);
  });
});

describe('wrapTables', () => {
  it('enveloppe les tableaux dans une région focalisable nommée', () => {
    const table = '<table><thead><tr><th>Signal</th><th>Où le <em>voir</em> &amp; "pourquoi"</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>';
    expect(tableLabel(table)).toBe('Tableau : Signal, Où le voir & "pourquoi"');
    expect(wrapTables(`<p>x</p>${table}<p>y</p>`)).toBe(
      `<p>x</p><div class="table-scroll" role="region" tabindex="0" aria-label="Tableau : Signal, Où le voir &amp; &quot;pourquoi&quot;">${table}</div><p>y</p>`,
    );
    expect(wrapTables('<p>sans tableau</p>')).toBe('<p>sans tableau</p>');
  });
});
