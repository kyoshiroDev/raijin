import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // Code porté de `legacy/supabase/functions` (docs/BENCH.md §2) : gardé à l'identique. Les `!` ont été ajoutés
    // par un codemod purement typé (noUncheckedIndexedAccess, aucun effet à l'exécution, BENCH.md §9 P11).
    files: ['src/ported/**/*.ts', 'src/functions/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Expressions de nettoyage des textes hostiles (caractères de contrôle) et fonctions vides des tests d'origine.
      'no-control-regex': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: ['{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
