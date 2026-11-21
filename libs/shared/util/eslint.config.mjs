import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  // Code partagé web / API / banc : TypeScript pur, sans API Node ni Deno (PROMPT.md §1).
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'Lib partagée : aucune API Node.' },
            { group: ['fs', 'path', 'crypto', 'http', 'https', 'os', 'child_process', 'buffer', 'stream', 'url'], message: 'Lib partagée : aucune API Node.' },
            { group: ['npm:*', 'jsr:*', 'https://*'], message: 'Lib partagée : aucune dépendance Deno.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Lib partagée : pas de process (Node).' },
        { name: 'Buffer', message: 'Lib partagée : pas de Buffer (Node), utiliser Uint8Array.' },
        { name: 'Deno', message: 'Lib partagée : pas de Deno.' },
        { name: 'require', message: 'Lib partagée : imports ES uniquement.' },
      ],
    },
  },
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/vitest.config.{js,ts,mjs,mts}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
