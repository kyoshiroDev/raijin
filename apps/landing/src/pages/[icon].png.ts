import type { APIRoute, GetStaticPaths } from 'astro';
import { readFileSync } from 'node:fs';
import { brandFilePath } from '../lib/og/brand-files';

/**
 * Icônes de la charte publiées à la racine (`/icon-180.png` pour iOS, `/icon-512.png` pour le logo du JSON-LD
 * `Organization`), copiées au build depuis `libs/brand/icons` (aucune copie versionnée).
 */
const ICONS = ['icon-180', 'icon-192', 'icon-512'] as const;

export const getStaticPaths = (() => ICONS.map((icon) => ({ params: { icon } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ params }) => {
  const icon = ICONS.find((name) => name === params['icon']);
  if (!icon) return new Response(null, { status: 404 });
  const file = readFileSync(brandFilePath(`icons/${icon}.png`));
  return new Response(new Uint8Array(file), { headers: { 'Content-Type': 'image/png' } });
};
