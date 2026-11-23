import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/bench/verdicts',
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'bench-verdicts',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/libs/bench/verdicts',
      provider: 'v8' as const,
      // Ces fonctions produiront les chiffres de justesse (et peut-être le marketing) : seuil élevé.
      enabled: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/testing/**', 'src/index.ts'],
      reporter: ['text-summary'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
}));
