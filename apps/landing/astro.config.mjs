// @ts-check
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// Landing Raijin Shield (Astro 7) : statique, zéro JS par défaut. Contenu complet en phase 7 (seo-astro).
export default defineConfig({
  site: 'https://raijinshield.com',
  outDir: '../../dist/apps/landing',
  trailingSlash: 'never',
  build: { format: 'file' },
  vite: {
    plugins: [tailwindcss()],
    server: { fs: { allow: ['../..'] } },
  },
});
