/**
 * Identité de l'éditeur (mentions légales, CGU/CGV, politique de confidentialité).
 * Informations fournies par l'éditeur le 2026-11-27 ; source unique pour toutes les pages légales.
 */
export const EDITOR = {
  /** Nom suivi de la mention « EI » (art. R526-27 du Code de commerce). */
  name: 'Grégory Tahir EI',
  tradeName: 'Raijin Shield',
  legalForm: 'Entrepreneur individuel (micro-entreprise)',
  siren: '512 926 460',
  siret: '512 926 460 00027',
  ape: '5829C (Édition de logiciels applicatifs)',
  address: '26 rue des Tiphoines, 91240 Saint-Michel-sur-Orge, France',
  publicationDirector: 'Grégory Tahir',
  contactEmail: 'contact@raijinshield.com',
  supportEmail: 'support@raijinshield.com',
  // TODO TVA : régime non confirmé par l'éditeur. Ne rien afficher tant qu'il n'est pas validé
  // (franchise en base « TVA non applicable, art. 293 B du CGI » ou numéro de TVA intracommunautaire).
} as const;

/** Hébergeur du site et de l'application. */
export const HOST = {
  name: 'OVH SAS (OVHcloud)',
  address: '2 rue Kellermann, 59100 Roubaix, France',
} as const;
