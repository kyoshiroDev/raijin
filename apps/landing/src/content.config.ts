// Module virtuel d'Astro, inconnu de la règle des frontières Nx.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { defineCollection } from 'astro:content';
import { file, glob } from 'astro/loaders';
import { z } from 'astro/zod';

/**
 * Contenus de la landing (docs/ARCHITECTURE.md §15.5). Zod ne sert qu'au build : aucun JS envoyé au navigateur.
 * - `guides` : un fichier Markdown par guide (`src/content/guides/<slug>.md`), liens croisés par `related`.
 * - `faq` : questions partagées par l'accueil et la page FAQ (`src/content/faq.json`).
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const guides = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/guides' }),
  schema: z.object({
    title: z.string().min(10).max(60),
    description: z.string().min(120).max(160),
    /** Titre visible (h1), plus long que le title si besoin. */
    heading: z.string().min(10).max(90),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    readingMinutes: z.number().int().min(1).max(30),
    related: z.array(z.string().regex(SLUG)).min(1).max(4),
    sources: z
      .array(z.object({ label: z.string().min(3).max(120), url: z.url().startsWith('https://') }))
      .min(1)
      .max(8),
  }),
});

/**
 * Les réponses peuvent citer les valeurs du catalogue des plans avec des jetons `{anonAnalysesPerDay}`,
 * `{freeAnalysesPerDay}`, `{trialDays}`, `{trialAnalysesPerDay}`, `{proMonthly}`, `{proYearly}` (remplacés au build).
 */
const faq = defineCollection({
  loader: file('src/content/faq.json'),
  schema: z.object({
    question: z.string().min(10).max(140),
    answer: z.string().min(20).max(600),
    /** Ordre d'affichage. */
    order: z.number().int().min(1),
    /** Affichée sur l'accueil (sinon page FAQ seulement). */
    home: z.boolean().default(false),
  }),
});

export const collections = { guides, faq };
