import { describe, expect, it } from 'vitest';
import { DISCLAIMER, fillCatalogTokens, LEGAL_TODO } from './content';
import { PRICING } from './pricing';

describe('contenu de la landing', () => {
  it('contient la mention « pas un conseil en investissement »', () => {
    expect(DISCLAIMER).toBe(
      "Raijin Shield fournit des analyses de sécurité à titre informatif. Ce n'est pas un conseil en investissement. Les memecoins sont extrêmement risqués : ne mise que ce que tu peux perdre.",
    );
  });

  it('marque les champs légaux non renseignés sans inventer d’identité', () => {
    expect(LEGAL_TODO).toBe('À compléter');
  });

  it('insère les valeurs du catalogue dans les textes', () => {
    expect(fillCatalogTokens('{anonAnalysesPerDay} par jour, {proMonthly}', PRICING)).toBe(
      `${PRICING.anonAnalysesPerDay} par jour, ${PRICING.pro.monthly}`,
    );
    expect(() => fillCatalogTokens('{inconnu}', PRICING)).toThrow(/inconnu/);
  });
});
