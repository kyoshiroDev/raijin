import { fakeAnalysis } from '@raijin/web-data-access';
import { formatMetric, safeSourceUrl, statusCounts, tokenDisplayName } from './check-display';

const NBSP = ' ';

describe('formatMetric', () => {
  it('montant compact, valeur exacte à part', () => {
    const formatted = formatMetric({ key: 'liquidity_usd', label: 'Liquidité', value: 1_284_530, unit: 'usd' });
    expect(formatted.text).toBe('1,3 M$');
    expect(formatted.exact).toBe(`1${NBSP}284${NBSP}530${NBSP}$`);
    expect(formatted.mono).toBe(true);
  });

  it('pourcentage (valeur 0–100), durée, nombre, adresse, booléen, texte, absent', () => {
    expect(formatMetric({ key: 'a', label: 'a', value: 62.3, unit: 'percent' }).text).toBe(`62,3${NBSP}%`);
    expect(formatMetric({ key: 'a', label: 'a', value: 214.5, unit: 'days' })).toMatchObject({ text: `215${NBSP}j`, exact: `214,5${NBSP}jours` });
    expect(formatMetric({ key: 'a', label: 'a', value: 1, unit: 'hours' }).exact).toBe(`1${NBSP}heure`);
    expect(formatMetric({ key: 'a', label: 'a', value: 14, unit: 'count' }).text).toBe('14');
    expect(formatMetric({ key: 'a', label: 'a', value: 2.5, unit: 'sol' }).text).toBe(`2,5${NBSP}SOL`);
    const address = formatMetric({ key: 'a', label: 'a', value: '92szaoSfeTQtot2WrbK4HSCYcVt6P6NdoHLpfohws8Fo', unit: 'address' });
    expect(address).toMatchObject({ text: '92sz…s8Fo', exact: '92szaoSfeTQtot2WrbK4HSCYcVt6P6NdoHLpfohws8Fo', mono: true });
    expect(formatMetric({ key: 'a', label: 'a', value: true, unit: null }).text).toBe('Oui');
    expect(formatMetric({ key: 'a', label: 'a', value: 'Bon', unit: null })).toMatchObject({ text: 'Bon', mono: false });
    expect(formatMetric({ key: 'a', label: 'a', value: null, unit: 'usd' })).toMatchObject({ text: 'Indisponible', missing: true });
  });
});

describe('safeSourceUrl', () => {
  it('garde un lien https de la liste blanche', () => {
    expect(safeSourceUrl('https://dexscreener.com/solana/abc')).toBe('https://dexscreener.com/solana/abc');
    expect(safeSourceUrl('https://www.geckoterminal.com/solana/tokens/abc')).not.toBeNull();
  });

  it.each([
    'http://dexscreener.com/solana/abc',
    'javascript:alert(1)',
    'https://dexscreener.com.evil.io/x',
    'https://evil.io/?u=https://rugcheck.xyz',
    'https://user@rugcheck.xyz/',
    '//rugcheck.xyz/tokens/x',
    'data:text/html,<script>alert(1)</script>',
  ])('refuse %s', (url) => {
    expect(safeSourceUrl(url)).toBeNull();
  });

  it('accepte null', () => {
    expect(safeSourceUrl(null)).toBeNull();
  });
});

describe('statusCounts / tokenDisplayName', () => {
  it('compte les statuts (danger d’abord)', () => {
    expect(statusCounts(fakeAnalysis('danger').checks)).toEqual([
      { status: 'danger', count: 4 },
      { status: 'warn', count: 1 },
      { status: 'ok', count: 4 },
    ]);
  });

  it('nom, sinon symbole, sinon mint tronqué', () => {
    expect(tokenDisplayName({ name: 'A', symbol: 'B' }, 'x')).toBe('A');
    expect(tokenDisplayName({ name: null, symbol: 'B' }, 'x')).toBe('B');
    expect(tokenDisplayName({ name: null, symbol: null }, '4ajVfUTrtcSat6U7vtpCTU4MM98oob4yqSwkg97RfZiq')).toBe('4ajV…fZiq');
  });
});
