import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanActivateFn, type Params } from '@angular/router';
import { ANALYSIS_INPUT_MAX_LENGTH, extractSolanaAddress } from '@raijin/shared-util';

/** Paramètre du formulaire GET de la landing sans JS (`app…/analyse?mint=<saisie>`, docs/ARCHITECTURE.md §15). */
export const MINT_QUERY_PARAM = 'mint';

// Caractères de contrôle (C0, DEL, C1) : jamais recopiés dans le champ.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Saisie reçue par l'URL, bornée et nettoyée avant d'être recopiée dans le champ (valeur hostile possible). */
export function sanitizeMintQuery(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(CONTROL_CHARS, '').slice(0, ANALYSIS_INPUT_MAX_LENGTH).trim();
}

/**
 * Repli sans JS de la landing : `/analyse?mint=<saisie>`. Adresse (ou lien DexScreener, pump.fun, Solscan, Birdeye)
 * reconnue → `/analyse/<mint>` en remplaçant l'entrée d'historique, les autres paramètres (attribution `utm_*`,
 * `rj_ref`, `rj_lp`) conservés. Saisie invalide ou trop longue → l'écran d'analyse s'affiche, champ prérempli
 * (saisie nettoyée) et message d'erreur. Aucun appel réseau : simple calcul sur l'URL.
 */
export const mintQueryRedirect: CanActivateFn = (route) => {
  const raw = route.queryParamMap.get(MINT_QUERY_PARAM);
  if (raw === null) return true;
  // Une saisie plus longue que le champ n'est jamais tronquée en silence vers une adresse : invalide.
  const extracted = raw.length > ANALYSIS_INPUT_MAX_LENGTH ? null : extractSolanaAddress(raw);
  if (!extracted) return true;
  const router = inject(Router);
  const queryParams: Params = { ...route.queryParams };
  delete queryParams[MINT_QUERY_PARAM];
  return new RedirectCommand(router.createUrlTree(['/analyse', extracted.address], { queryParams }), { replaceUrl: true });
};
