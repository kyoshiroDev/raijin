// @ts-check
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// Landing Raijin Shield (Astro 5) : statique, zéro JS par défaut. Contenu complet en phase 7 (seo-astro).
export default defineConfig({
  site: 'https://raijinshield.com',
  outDir: '../../dist/apps/landing',
  trailingSlash: 'never',
  build: { format: 'file' },
  vite: {
    // Cast : @tailwindcss/vite est typé avec la version de Vite de la racine, Astro 5 embarque la sienne.
    plugins: [/** @type {any} */ (tailwindcss())],
    server: { fs: { allow: ['../..'] } },
  },
});
