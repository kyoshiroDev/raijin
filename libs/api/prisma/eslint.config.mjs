import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  { ignores: ['**/src/generated/**'] },
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            // Outillage de la CLI Prisma (dev uniquement) : configuration et seed local.
            '{projectRoot}/prisma.config.ts',
            '{projectRoot}/prisma/seed.ts',
          ],
          // Utilisé par le client généré (src/generated, ignoré par Git donc invisible au graphe Nx).
          ignoredDependencies: ['@prisma/client'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
