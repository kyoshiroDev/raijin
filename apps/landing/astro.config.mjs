// @ts-check
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, envField } from 'astro/config';
import { assertAllowedAppUrl } from './src/lib/app-url-policy.ts';

// APP_URL : https uniquement (http seulement vers une adresse de bouclage, pour les e2e). Sinon, le build échoue.
if (process.env['APP_URL']) assertAllowedAppUrl(process.env['APP_URL']);

// Landing Raijin Shield (Astro 7) : statique, zéro JS par défaut. Contenu complet en phase 7 (seo-astro).
export default defineConfig({
  site: 'https://raijinshield.com',
  outDir: '../../dist/apps/landing',
  trailingSlash: 'never',
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
