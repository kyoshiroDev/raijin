import { truncateMiddle } from './address';

describe('truncateMiddle', () => {
  it('tronque au milieu avec 4 caractères de chaque côté', () => {
    expect(truncateMiddle('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe(
      '7xKX…gAsU',
    );
  });

  it('accepte des longueurs personnalisées', () => {
    expect(truncateMiddle('abcdefghijklmnop', 2, 3)).toBe('ab…nop');
  });

  it('laisse intactes les chaînes courtes', () => {
    expect(truncateMiddle('abcdefghi')).toBe('abcdefghi');
    expect(truncateMiddle('')).toBe('');
  });

  it('ignore les longueurs négatives', () => {
    expect(truncateMiddle('abcdefghijkl', -1, 2)).toBe('…kl');
  });
});
