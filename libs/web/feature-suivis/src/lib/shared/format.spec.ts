import { fakeAlerts } from '@raijin/web-data-access';
import { alertSentence, formatPct, formatRelative, tokenLabel, tokenSymbol } from './format';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');

describe('formatage des suivis et alertes', () => {
  it('durées relatives courtes', () => {
    expect(formatRelative('2026-11-22T11:59:40.000Z', NOW)).toBe('à l’instant');
    expect(formatRelative('2026-11-22T11:48:00.000Z', NOW)).toBe('il y a 12\u00a0min');
    expect(formatRelative('2026-11-22T09:00:00.000Z', NOW)).toBe('il y a 3\u00a0h');
    expect(formatRelative('2026-11-21T09:00:00.000Z', NOW)).toBe('hier');
    expect(formatRelative('2026-11-18T09:00:00.000Z', NOW)).toBe('il y a 4\u00a0jours');
    expect(formatRelative('2026-11-01T09:00:00.000Z', NOW)).toMatch(/^le 1 nov/);
  });

  it('nom de token non fiable, repli sur l’adresse tronquée', () => {
    expect(tokenLabel({ name: 'Bonk', symbol: 'BONK' }, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')).toBe('Bonk');
    expect(tokenLabel({ name: null, symbol: 'BONK' }, 'x')).toBe('BONK');
    expect(tokenLabel(null, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')).toBe('DezX…B263');
    expect(tokenSymbol({ name: 'Bonk', symbol: 'BONK' })).toBe('BONK');
    expect(tokenSymbol({ name: null, symbol: 'BONK' })).toBeNull();
  });

  it('phrases d’alerte factuelles pour chaque type, sans urgence ni conseil', () => {
    expect(formatPct(42.5)).toBe('42,5\u00a0%');
    const sentences = fakeAlerts().map(alertSentence);
    expect(sentences[0]).toContain('42,5');
    expect(sentences[0]).toContain('120\u00a0k$');
    expect(sentences[1]).toBe('Le verdict est passé de Prudence à Danger lors de la dernière revérification.');
    expect(sentences[2]).toContain('vente ou transfert');
    expect(sentences[3]).toContain('autorité de mint');
    expect(sentences[4]).toContain('autorité de freeze');
    for (const text of sentences) expect(text).not.toMatch(/vends|achète|vite|urgent|dépêche/i);
  });
});
