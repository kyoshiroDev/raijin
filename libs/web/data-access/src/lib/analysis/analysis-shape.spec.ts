import { ANALYSIS_CHECK_IDS, TOKEN_NAME_MAX_LENGTH, TOKEN_SYMBOL_MAX_LENGTH, analysisResultSchema } from '@raijin/shared-contracts';
import { fakeAnalysis } from '../testing/analysis-fixtures';
import { AnalysisShapeError, KNOWN_CHECK_IDS, SHAPE_TOKEN_NAME_MAX, SHAPE_TOKEN_SYMBOL_MAX, readAnalysisResult } from './analysis-shape';

type Loose = Record<string, unknown>;

/** Copie profonde modifiable d'une analyse valide. */
function body(): Loose {
  return JSON.parse(JSON.stringify(fakeAnalysis('safe'))) as Loose;
}

const firstCheck = (value: Loose) => (value['checks'] as Loose[])[0] as Loose;
const firstSource = (value: Loose) => (firstCheck(value)['sources'] as Loose[])[0] as Loose;
const token = (value: Loose) => value['token'] as Loose;

describe('readAnalysisResult (contrôle de forme avant Zod)', () => {
  it('copies alignées sur les contrats (identifiants, longueurs)', () => {
    expect(Object.keys(KNOWN_CHECK_IDS).sort()).toEqual([...ANALYSIS_CHECK_IDS].sort());
    expect(SHAPE_TOKEN_NAME_MAX).toBe(TOKEN_NAME_MAX_LENGTH);
    expect(SHAPE_TOKEN_SYMBOL_MAX).toBe(TOKEN_SYMBOL_MAX_LENGTH);
  });

  it('accepte une analyse valide', () => {
    expect(readAnalysisResult(body()).verdict).toBe('safe');
  });

  it.each([
    ['url absente', (b: Loose) => delete firstSource(b)['url']],
    ['url non textuelle', (b: Loose) => (firstSource(b)['url'] = 42)],
    ['nom de source absent', (b: Loose) => delete firstSource(b)['name']],
    ['source non objet', (b: Loose) => ((firstCheck(b)['sources'] as unknown[])[0] = 'dexscreener')],
    ['identifiant de contrôle inconnu', (b: Loose) => (firstCheck(b)['id'] = 'moon')],
    ['identifiant hérité du prototype', (b: Loose) => (firstCheck(b)['id'] = '__proto__')],
    ['identifiant toString', (b: Loose) => (firstCheck(b)['id'] = 'toString')],
  ])('refuse : %s', (_label, mutate) => {
    const value = body();
    mutate(value);
    expect(() => readAnalysisResult(value)).toThrow(AnalysisShapeError);
  });

  it('url null acceptée (source sans lien)', () => {
    const value = body();
    firstSource(value)['url'] = null;
    expect(() => readAnalysisResult(value)).not.toThrow();
  });

  it('nom et symbole nettoyés dès l’affichage, comme le fera Zod', () => {
    const value = body();
    token(value)['name'] = 'Bon\u202Ek\u200B  Token\u0007';
    token(value)['symbol'] = 'B'.repeat(40);
    const shown = readAnalysisResult(value);
    const validated = analysisResultSchema.parse(value);
    expect(shown.token.name).toBe(validated.token.name);
    expect(shown.token.symbol).toBe(validated.token.symbol);
    const hidden = Array.from(shown.token.name ?? '').filter((char) => [0x202e, 0x200b, 0x07].includes(char.codePointAt(0) ?? 0));
    expect(hidden).toEqual([]);
    expect(Array.from(shown.token.symbol ?? '')).toHaveLength(TOKEN_SYMBOL_MAX_LENGTH);
  });

  it('nom absent : null conservé', () => {
    const value = body();
    token(value)['name'] = null;
    expect(readAnalysisResult(value).token.name).toBeNull();
  });
});
