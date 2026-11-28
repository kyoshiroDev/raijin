import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/shared/risk-engine',
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'shared-risk-engine',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/libs/shared/risk-engine',
      provider: 'v8' as const,
      // Seuil imposé (docs/SCORING.md) : le moteur décide du verdict, il doit être testé à fond.
      enabled: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/testing/**', 'src/index.ts', 'src/lib/contract.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
}));
