import { describe, expect, it } from 'vitest';
import { splitInversions } from './typography';

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
