// @ts-check
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, envField } from 'astro/config';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAllowedAppUrl } from './src/lib/app-url-policy.ts';
import { frenchSpacingHtml } from './src/lib/typography.ts';

// APP_URL : https uniquement (http seulement vers une adresse de bouclage, pour les e2e). Sinon, le build échoue.
if (process.env['APP_URL']) assertAllowedAppUrl(process.env['APP_URL']);

/**
 * Typographie française appliquée au HTML construit (espaces insécables avant `: ; ? ! »`, après `«`) : au build,
 * aucun JS côté client. Voir `frenchSpacingHtml` (src/lib/typography.ts).
 * @returns {import('astro').AstroIntegration}
 */
function frenchTypography() {
  return {
    name: 'raijin-french-typography',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const root = fileURLToPath(dir);
        const entries = await readdir(root, { recursive: true });
        for (const entry of entries) {
          if (!entry.endsWith('.html')) continue;
          const file = join(root, entry);
          const html = await readFile(file, 'utf8');
          const next = frenchSpacingHtml(html);
          if (next !== html) await writeFile(file, next);
        }
      },
    },
  };
}

// Landing Raijin Shield (Astro 7) : statique, zéro JS par défaut. Contenu complet en phase 7 (seo-astro).
export default defineConfig({
  site: 'https://raijinshield.com',
  outDir: '../../dist/apps/landing',
  trailingSlash: 'never',
  integrations: [frenchTypography()],
  // `inlineStylesheets: 'never'` : aucun <style> en ligne, la CSP peut rester `style-src 'self'`.
  build: { format: 'file', inlineStylesheets: 'never' },
  // Variables publiques lues au build (docs/ENV.md, docs/ANALYTICS.md). Vides : ni GA4 ni bannière, pas de meta.
  env: {
    schema: {
      GA4_MEASUREMENT_ID: envField.string({ context: 'server', access: 'public', optional: true, max: 32 }),
      GOOGLE_SITE_VERIFICATION: envField.string({ context: 'server', access: 'public', optional: true, max: 128 }),
      APP_URL: envField.string({
        context: 'server',
        access: 'public',
        optional: true,
        url: true,
        default: 'https://app.raijinshield.com',
      }),
    },
  },
  vite: {
    plugins: [tailwindcss()],
    server: { fs: { allow: ['../..'] } },
    // Aucun script inline (CSP `script-src 'self'`) : les scripts restent des fichiers /_astro/*.js.
    build: { assetsInlineLimit: 0 },
  },
});
