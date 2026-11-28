/** Feuille complète émise par le build (`styles-full`, `inject: false` dans apps/web/project.json). */
export const FULL_STYLESHEET_HREF = 'styles-full.css';

let loading: Promise<void> | null = null;

/**
 * Charge une fois la feuille complète (utilitaires de l'espace admin et de /_design, exclus de la feuille
 * initiale : docs/ARCHITECTURE.md §10.6, G5). Résolue au chargement de la feuille, ou en cas d'échec (l'écran
 * s'affiche alors avec la feuille initiale, un nouvel essai aura lieu à la prochaine navigation) : la
 * navigation n'est jamais bloquée. À attendre avant d'afficher l'écran (pas de rendu sans ses styles).
 */
export function loadFullStylesheet(doc: Document = document): Promise<void> {
  loading ??= new Promise<void>((resolve) => {
    const existing = doc.querySelector<HTMLLinkElement>(`link[data-rj-full-stylesheet]`);
    if (existing) {
      resolve();
      return;
    }
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = FULL_STYLESHEET_HREF;
    link.dataset['rjFullStylesheet'] = '';
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      loading = null;
      resolve();
    };
    doc.head.appendChild(link);
  });
  return loading;
}

/** Remise à zéro pour les tests. */
export function resetFullStylesheetForTests(): void {
  loading = null;
}
