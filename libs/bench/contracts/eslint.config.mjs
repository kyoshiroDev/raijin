import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  // Contrats du banc (front Angular et API Nest) : TypeScript pur, sans API Node ni Deno.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'Contrats du banc : aucune API Node.' },
            { group: ['fs', 'path', 'crypto', 'http', 'https', 'os', 'child_process', 'buffer', 'stream', 'url'], message: 'Contrats du banc : aucune API Node.' },
            { group: ['npm:*', 'jsr:*', 'https://*'], message: 'Contrats du banc : aucune dépendance Deno.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Contrats du banc : pas de process (Node).' },
        { name: 'Buffer', message: 'Contrats du banc : pas de Buffer (Node), utiliser Uint8Array.' },
        { name: 'Deno', message: 'Contrats du banc : pas de Deno.' },
        { name: 'require', message: 'Contrats du banc : imports ES uniquement.' },
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
