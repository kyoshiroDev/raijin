// Suivi de lecture d'un guide : `guide_lu` une fois, au-delà de 60 % de l'article.
import { bindGuideRead } from '../lib/guide-read';

const article = document.querySelector<HTMLElement>('article[data-guide-slug]');
if (article) bindGuideRead(article);
