import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  // Code du banc (front et future API, phase 8 bis) : TypeScript pur, sans API Node ni Deno (PROMPT.md §1).
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'Lib pure du banc : aucune API Node.' },
            { group: ['fs', 'path', 'crypto', 'http', 'https', 'os', 'child_process', 'buffer', 'stream', 'url'], message: 'Lib pure du banc : aucune API Node.' },
            { group: ['npm:*', 'jsr:*', 'https://*'], message: 'Lib pure du banc : aucune dépendance Deno.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Lib pure du banc : pas de process (Node).' },
        { name: 'Buffer', message: 'Lib pure du banc : pas de Buffer (Node), utiliser Uint8Array.' },
        { name: 'Deno', message: 'Lib pure du banc : pas de Deno.' },
        { name: 'require', message: 'Lib pure du banc : imports ES uniquement.' },
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
