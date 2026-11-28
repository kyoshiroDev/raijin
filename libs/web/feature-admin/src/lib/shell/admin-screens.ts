import { type IconNode } from 'lucide';
import { AdminIcons } from '../ui/admin-icons';

/** Écran de l'espace admin (PROMPT.md §4.7) : navigation, titre de l'onglet et en-tête de page. */
export interface AdminScreen {
  /** Chemin relatif à `/admin` (`''` = vue d'ensemble). */
  readonly path: string;
  /** Libellé court de la navigation. */
  readonly label: string;
  /** Titre de la page (`<h1>`). */
  readonly title: string;
  /** Phrase d'introduction sous le titre. */
  readonly description: string;
  readonly icon: IconNode;
}

/** Les 9 écrans, dans l'ordre de la navigation. Les pages (admin-analytics) reprennent `title` et `description`. */
export const ADMIN_SCREENS: readonly AdminScreen[] = [
  {
    path: '',
    label: 'Vue d’ensemble',
    title: 'Vue d’ensemble',
    description: 'Les chiffres clés de la période et leur évolution.',
    icon: AdminIcons.overview,
  },
  {
    path: 'trafic',
    label: 'Trafic',
    title: 'Trafic',
    description: 'Visiteurs, sessions et pages vues, lus dans Google Analytics 4.',
    icon: AdminIcons.traffic,
  },
  {
    path: 'seo',
    label: 'SEO',
    title: 'SEO',
    description: 'Clics, impressions et positions dans Google Search Console.',
    icon: AdminIcons.seo,
  },
  {
    path: 'acquisition',
    label: 'Acquisition',
    title: 'Acquisition',
    description: 'D’où viennent les inscriptions et les abonnés.',
    icon: AdminIcons.acquisition,
  },
  {
    path: 'revenus',
    label: 'Revenus',
    title: 'Revenus',
    description: 'MRR, abonnés actifs, nouveaux abonnements et résiliations.',
    icon: AdminIcons.revenue,
  },
  {
    path: 'essais',
    label: 'Essais',
    title: 'Essais Pro',
    description: 'Essais commencés, en cours et convertis.',
    icon: AdminIcons.trials,
  },
  {
    path: 'utilisateurs',
    label: 'Utilisateurs',
    title: 'Utilisateurs',
    description: 'Recherche, fiches et actions sur les comptes, toutes journalisées.',
    icon: AdminIcons.users,
  },
  {
    path: 'produit',
    label: 'Produit',
    title: 'Produit',
    description: 'Analyses, suivis, alertes et scans de wallet.',
    icon: AdminIcons.product,
  },
  {
    path: 'sante',
    label: 'Santé',
    title: 'Santé',
    description: 'Jobs, quotas des sources de données et alertes techniques.',
    icon: AdminIcons.health,
  },
];

/** Écran déclaré pour un chemin relatif (`trafic`, `''`…). */
export function adminScreen(path: string): AdminScreen {
  return ADMIN_SCREENS.find((screen) => screen.path === path) ?? (ADMIN_SCREENS[0] as AdminScreen);
}

/** Lien absolu d'un écran. */
export function adminScreenLink(screen: AdminScreen): string {
  return screen.path ? `/admin/${screen.path}` : '/admin';
}
