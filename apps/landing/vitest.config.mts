import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'landing',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
