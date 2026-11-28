import { formatCompactAmount, formatExactAmount, formatPercent } from './format';

/** Remplace l'espace insécable par une espace simple pour des attentes lisibles. */
const plain = (value: string) => value.replace(/\u00a0/g, ' ');

describe('formatCompactAmount', () => {
  it('formate les millions et milliers en fr-FR', () => {
    expect(plain(formatCompactAmount(1_234_567))).toBe('1,2 M$');
    expect(plain(formatCompactAmount(340_000))).toBe('340 k$');
  });

  it('formate les petits montants avec une espace avant le symbole', () => {
    expect(plain(formatCompactAmount(12.5))).toBe('12,5 $');
  });

  it('accepte un autre symbole ou aucun', () => {
    expect(plain(formatCompactAmount(2_500_000, '€'))).toBe('2,5 M€');
    expect(plain(formatCompactAmount(1500, ''))).toBe('1,5 k');
  });

  it('renvoie un tiret pour une valeur non finie', () => {
    expect(formatCompactAmount(Number.NaN)).toBe('—');
  });
});

describe('formatExactAmount', () => {
  it('donne la valeur exacte', () => {
    expect(plain(formatExactAmount(1_234_567.891))).toBe('1 234 567,89 $');
    expect(formatExactAmount(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('formate une fraction en pourcentage', () => {
    expect(plain(formatPercent(0.4123))).toBe('41,2 %');
    expect(formatPercent(Number.NaN)).toBe('—');
  });
});
