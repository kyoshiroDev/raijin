import type { APIRoute, GetStaticPaths } from 'astro';
import { getGuides } from '../../lib/collections';
import { readBrandFile } from '../../lib/og/brand-files';
import { renderOgPng } from '../../lib/og/render';
import type { OgPage } from '../../lib/og/template';
import { STATIC_PAGES } from '../../lib/pages';

/** Une image Open Graph 1200 × 630 par page et par guide, générée au build (`/og/<slug>.png`). */
export const getStaticPaths = (async () => {
  const pages = new Map<string, OgPage>();
  for (const page of Object.values(STATIC_PAGES)) {
    if (!page.indexable || pages.has(page.og)) continue;
    pages.set(page.og, {
      kicker: page.path === '/' ? 'Le bouclier anti-rug des memecoins Solana' : page.heading,
      title: page.path === '/' ? page.heading : page.title.replace(/ — Raijin Shield$/, ''),
      subtitle: page.path === '/' ? '9 contrôles, un verdict clair : Sain, Prudence ou Danger.' : 'La sécurité des tokens Solana, en lecture seule.',
    });
  }
  for (const guide of await getGuides()) {
    pages.set(`guide-${guide.id}`, {
      kicker: `Guide · ${guide.data.readingMinutes} min`,
      title: guide.data.title,
      subtitle: 'Les signaux à vérifier avant de signer.',
    });
  }
  return [...pages].map(([slug, page]) => ({ params: { slug }, props: { page } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ page: OgPage }> = async ({ props }) => {
  const png = await renderOgPng(props.page, {
    markSvg: readBrandFile('logos/raijin-mark-color.svg'),
    raiSvg: readBrandFile('mascot/rai-hero.svg'),
  });
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
