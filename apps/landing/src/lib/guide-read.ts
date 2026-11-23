import { track } from './analytics/track';

/** Part de l'article à dépasser pour compter une lecture. */
export const GUIDE_READ_THRESHOLD = 0.6;

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Vrai quand le bas de la fenêtre a dépassé `threshold` de la hauteur de l'article. */
export function hasReadEnough(articleTop: number, articleHeight: number, viewportBottom: number, threshold = GUIDE_READ_THRESHOLD): boolean {
  if (articleHeight <= 0) return false;
  return (viewportBottom - articleTop) / articleHeight >= threshold;
}

/** `guide_lu { slug }` une seule fois par page vue, au défilement (écoute passive, retirée après l'envoi). */
export function bindGuideRead(article: HTMLElement, win: Window = window): void {
  const slug = article.dataset['guideSlug'] ?? '';
  if (!SLUG.test(slug)) return;
  let done = false;
  const check = () => {
    if (done) return;
    const rect = article.getBoundingClientRect();
    if (hasReadEnough(rect.top + win.scrollY, rect.height, win.scrollY + win.innerHeight)) {
      done = true;
      win.removeEventListener('scroll', check);
      track('guide_lu', { slug });
    }
  };
  win.addEventListener('scroll', check, { passive: true });
  check();
}
