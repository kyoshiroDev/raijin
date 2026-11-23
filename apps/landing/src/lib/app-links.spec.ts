// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://raijinshield.com/"}
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANALYSE_FORM_ERRORS, resolveAnalyseTarget } from './analyse-form';
import { ATTRIBUTION_SESSION_KEY } from './analytics/constants';
import { buildAnalyseUrl } from './app-links';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ACTION = 'https://app.raijinshield.com/analyse';

describe('buildAnalyseUrl', () => {
  it('construit /analyse/<mint> pour une adresse valide', () => {
    expect(buildAnalyseUrl('https://app.raijinshield.com/', MINT)).toBe(`https://app.raijinshield.com/analyse/${MINT}`);
  });

  it.each(['', 'abc', `${MINT}/../../admin`, `${MINT}?x=1`, '//evil.example', 'javascript:alert(1)', `${MINT}0OIl`])(
    'refuse %s',
    (value) => {
      expect(buildAnalyseUrl('https://app.raijinshield.com', value)).toBeNull();
    },
  );
});

describe('resolveAnalyseTarget', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  it('accepte une adresse brute', () => {
    expect(resolveAnalyseTarget(`  ${MINT} `, ACTION, document)).toEqual({ ok: true, url: `${ACTION}/${MINT}` });
  });

  it('extrait l’adresse d’un lien DexScreener ou pump.fun', () => {
    expect(resolveAnalyseTarget(`https://dexscreener.com/solana/${MINT}`, ACTION, document)).toEqual({
      ok: true,
      url: `${ACTION}/${MINT}`,
    });
    expect(resolveAnalyseTarget(`pump.fun/coin/${MINT}`, ACTION, document)).toMatchObject({ ok: true });
  });

  it('renvoie une erreur lisible pour une saisie vide ou invalide', () => {
    expect(resolveAnalyseTarget('   ', ACTION, document)).toEqual({ ok: false, error: ANALYSE_FORM_ERRORS.empty });
    expect(resolveAnalyseTarget('pas une adresse', ACTION, document)).toEqual({
      ok: false,
      error: ANALYSE_FORM_ERRORS.invalid,
    });
    expect(resolveAnalyseTarget('https://evil.example/solana/x', ACTION, document)).toMatchObject({ ok: false });
  });

  it('ajoute l’attribution de première visite, jamais le mint ailleurs que dans le chemin', () => {
    sessionStorage.setItem(ATTRIBUTION_SESSION_KEY, JSON.stringify({ utmSource: 'x', landingPath: '/guides/x' }));
    const result = resolveAnalyseTarget(MINT, ACTION, document);
    expect(result.ok && new URL(result.url).pathname).toBe(`/analyse/${MINT}`);
    expect(result.ok && new URL(result.url).searchParams.get('utm_source')).toBe('x');
    expect(result.ok && new URL(result.url).searchParams.get('rj_lp')).toBe('/guides/x');
  });
});
