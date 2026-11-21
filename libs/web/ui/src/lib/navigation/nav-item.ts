import { type RjIconName } from '../icon/icons';

/** Entrée de navigation partagée par la barre d'onglets (mobile) et la barre latérale (desktop). */
export interface RjNavItem {
  readonly label: string;
  readonly path: string;
  readonly icon: RjIconName;
  /** Compteur affiché en pastille (ex. alertes non lues). */
  readonly badge?: number;
}

/** Libellé accessible d'un compteur : « 3 nouvelles », plafonné visuellement à 9+. */
export function badgeText(count: number | undefined): string {
  if (!count || count <= 0) {
    return '';
  }
  return count > 9 ? '9+' : String(count);
}
