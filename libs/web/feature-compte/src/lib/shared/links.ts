/** Lien de texte : souligné discret, cible tactile de 44 px, focus visible. */
export const TEXT_LINK =
  'inline-flex min-h-11 items-center rounded-sm font-medium text-ink underline decoration-line-strong underline-offset-4 transition-colors duration-150 ease-raijin hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/** Pages légales de la landing (Astro, phase 5). Chemins supposés, à confirmer avec seo-astro. */
export const LEGAL_LINKS = {
  terms: 'https://raijinshield.com/cgu',
  privacy: 'https://raijinshield.com/confidentialite',
} as const;

/** Mention légale obligatoire (BRAND.md). */
export const DISCLAIMER =
  'Raijin Shield fournit des analyses de sécurité à titre informatif. Ce n’est pas un conseil en investissement. Les memecoins sont extrêmement risqués : ne mise que ce que tu peux perdre.';
