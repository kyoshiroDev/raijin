import type { PricingView } from './pricing';

/** Mention légale obligatoire (PROMPT.md §4.5, BRAND.md) : pied de page de chaque page et page tarifs. */
export const DISCLAIMER =
  "Raijin Shield fournit des analyses de sécurité à titre informatif. Ce n'est pas un conseil en investissement. Les memecoins sont extrêmement risqués : ne mise que ce que tu peux perdre.";

/**
 * Champ légal non encore renseigné (à ce jour : médiateur de la consommation) : affiché tel quel, en évidence.
 * Aucune identité n'est inventée (docs/ARCHITECTURE.md §15.5).
 */
export const LEGAL_TODO = 'À compléter';

/** Date de dernière mise à jour des pages légales (affichée et reprise dans le sitemap). */
export const LEGAL_UPDATED_AT = new Date('2026-11-27T00:00:00.000Z');

/** Remplace les jetons `{anonAnalysesPerDay}`… d'un texte par les valeurs du catalogue des plans. */
export function fillCatalogTokens(text: string, pricing: PricingView): string {
  const values: Record<string, string> = {
    anonAnalysesPerDay: String(pricing.anonAnalysesPerDay),
    freeAnalysesPerDay: String(pricing.free.analysesPerDay),
    trialDays: String(pricing.trialDays),
    trialAnalysesPerDay: pricing.trialAnalysesPerDay === null ? 'illimitées' : String(pricing.trialAnalysesPerDay),
    proMonthly: pricing.pro.monthly,
    proYearly: pricing.pro.yearly,
  };
  return text.replace(/\{([a-zA-Z]+)\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Jeton de catalogue inconnu : ${match}`);
    return value;
  });
}
