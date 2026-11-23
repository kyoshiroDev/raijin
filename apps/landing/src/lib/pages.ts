/**
 * Pages statiques de la landing : chemin, title, description et image OG. Source unique pour les pages, le sitemap,
 * les images Open Graph et les tests (unicité, longueurs). Les guides viennent de la collection `guides`.
 */
export interface StaticPage {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** Titre court affiché sur l'image OG et dans le fil d'Ariane. */
  readonly heading: string;
  /** Slug de l'image `/og/<slug>.png`. */
  readonly og: string;
  /** Présente dans le sitemap (la 404 ne l'est pas). */
  readonly indexable: boolean;
}

export const STATIC_PAGES = {
  home: {
    path: '/',
    title: 'Raijin Shield — le bouclier anti-rug des memecoins Solana',
    description:
      "Colle l'adresse d'un token Solana : Raijin Shield vérifie 9 points de sécurité et te donne un verdict clair et sourcé, Sain, Prudence ou Danger.",
    heading: 'Vérifie avant de signer.',
    og: 'accueil',
    indexable: true,
  },
  tarifs: {
    path: '/tarifs',
    title: 'Tarifs Gratuit et Pro — Raijin Shield',
    description:
      "Gratuit pour vérifier quelques tokens par jour, Pro pour l'analyse illimitée, les alertes push et le scan de wallet. Essai Pro de 7 jours sans carte.",
    heading: 'Tarifs',
    og: 'tarifs',
    indexable: true,
  },
  commentCaMarche: {
    path: '/comment-ca-marche',
    title: 'Comment ça marche : les 9 contrôles — Raijin Shield',
    description:
      'Autorités de mint et de freeze, liquidité, holders, revente simulée, métadonnées, âge, créateur, RugCheck : comment Raijin Shield décide de son verdict.',
    heading: 'Comment ça marche',
    og: 'comment-ca-marche',
    indexable: true,
  },
  faq: {
    path: '/faq',
    title: 'Questions fréquentes — Raijin Shield',
    description:
      "Analyse sans compte, sources des données, lecture seule, essai Pro, résiliation : les réponses aux questions qu'on pose le plus souvent sur Raijin Shield.",
    heading: 'Questions fréquentes',
    og: 'faq',
    indexable: true,
  },
  guides: {
    path: '/guides',
    title: 'Guides sécurité des memecoins Solana — Raijin Shield',
    description:
      'Rug pull, mint authority, honeypot : des guides concrets pour comprendre les pièges des tokens Solana et vérifier un contrat avant de signer une transaction.',
    heading: 'Guides',
    og: 'guides',
    indexable: true,
  },
  mentionsLegales: {
    path: '/mentions-legales',
    title: 'Mentions légales — Raijin Shield',
    description:
      'Mentions légales du site raijinshield.com : éditeur du service Raijin Shield, directeur de la publication, hébergeur et contact pour toute question.',
    heading: 'Mentions légales',
    og: 'mentions-legales',
    indexable: true,
  },
  cgu: {
    path: '/cgu',
    title: "Conditions générales d'utilisation et de vente — Raijin Shield",
    description:
      "Conditions générales d'utilisation et de vente de Raijin Shield : compte, plans Gratuit et Pro, essai sans carte, paiement, résiliation et responsabilité.",
    heading: 'CGU et CGV',
    og: 'cgu',
    indexable: true,
  },
  confidentialite: {
    path: '/confidentialite',
    title: 'Politique de confidentialité et cookies — Raijin Shield',
    description:
      'Données traitées par Raijin Shield, cookies et stockage du navigateur, sous-traitants, durées de conservation et exercice de tes droits RGPD.',
    heading: 'Confidentialité',
    og: 'confidentialite',
    indexable: true,
  },
  notFound: {
    path: '/404',
    title: 'Page introuvable — Raijin Shield',
    description:
      "Cette page n'existe pas ou a été déplacée. Reviens à l'accueil de Raijin Shield pour vérifier un token Solana ou parcourir les guides de sécurité.",
    heading: 'Page introuvable',
    og: 'accueil',
    indexable: false,
  },
} as const satisfies Record<string, StaticPage>;

export type StaticPageKey = keyof typeof STATIC_PAGES;

/** Liens de navigation principale (en-tête et pied de page). */
export const NAV_LINKS = [
  { label: 'Comment ça marche', path: STATIC_PAGES.commentCaMarche.path },
  { label: 'Tarifs', path: STATIC_PAGES.tarifs.path },
  { label: 'Guides', path: STATIC_PAGES.guides.path },
  { label: 'FAQ', path: STATIC_PAGES.faq.path },
] as const;

export const LEGAL_LINKS = [
  { label: 'Mentions légales', path: STATIC_PAGES.mentionsLegales.path },
  { label: 'CGU et CGV', path: STATIC_PAGES.cgu.path },
  { label: 'Confidentialité', path: STATIC_PAGES.confidentialite.path },
] as const;
