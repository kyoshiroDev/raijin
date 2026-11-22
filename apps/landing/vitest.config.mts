import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      // Contrats lus par les tests d'alignement uniquement (les scripts de la landing n'en importent que des types).
      '@raijin/shared-contracts': fileURLToPath(
        new URL('../../libs/shared/contracts/src/index.ts', import.meta.url),
      ),
      '@raijin/shared-util': fileURLToPath(new URL('../../libs/shared/util/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'landing',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
