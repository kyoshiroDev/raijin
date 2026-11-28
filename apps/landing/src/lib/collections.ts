// Module virtuel d'Astro, inconnu de la règle des frontières Nx.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { getCollection, type CollectionEntry } from 'astro:content';
import { fillCatalogTokens } from './content';
import { PRICING } from './pricing';
import type { FaqItem } from './seo';

/** Questions de la FAQ triées, valeurs du catalogue des plans insérées. */
export async function getFaq(options: { homeOnly?: boolean } = {}): Promise<FaqItem[]> {
  const entries = await getCollection('faq');
  return entries
    .filter((entry) => !options.homeOnly || entry.data.home)
    .sort((a, b) => a.data.order - b.data.order)
    .map((entry) => ({
      id: entry.id,
      question: fillCatalogTokens(entry.data.question, PRICING),
      answer: fillCatalogTokens(entry.data.answer, PRICING),
    }));
}

export type Guide = CollectionEntry<'guides'>;

/** Guides du plus récent au plus ancien. */
export async function getGuides(): Promise<Guide[]> {
  const guides = await getCollection('guides');
  return guides.sort((a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime());
}

export function guidePath(slug: string): string {
  return `/guides/${slug}`;
}
