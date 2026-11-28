import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

/**
 * Raijin-banc-de-test (scope:bench) : code importé de l'ancien scanner (phase 1 bis).
 * Les frontières Nx (@nx/enforce-module-boundaries) restent actives via baseConfig.
 * Préfixe des sélecteurs : « app » (conservé du code d'origine, renommage en « bench » au portage).
 */
export default [
  ...nx.configs['flat/angular'],
  ...nx.configs['flat/angular-template'],
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      '@angular-eslint/directive-selector': ['error', { type: 'attribute', prefix: 'app', style: 'camelCase' }],
      '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'app', style: 'kebab-case' }],
    },
  },
  {
    files: ['**/*.html'],
    rules: {},
  },
];
