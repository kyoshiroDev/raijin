import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      // Libs partagées lues au build et par les tests (les scripts client n'importent que des types des contrats).
      '@raijin/shared-contracts': fileURLToPath(
        new URL('../../libs/shared/contracts/src/index.ts', import.meta.url),
      ),
      '@raijin/shared-util': fileURLToPath(new URL('../../libs/shared/util/src/index.ts', import.meta.url)),
      '@raijin/shared-risk-engine': fileURLToPath(
        new URL('../../libs/shared/risk-engine/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'landing',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
