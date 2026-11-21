import nx from '@nx/eslint-plugin';

/**
 * Frontières du monorepo Raijin Shield (PROMPT.md §1, détail dans docs/ARCHITECTURE.md).
 * - feature → feature, ui, data-access, util, contracts, brand
 * - ui → ui, util, brand
 * - scope:web ↮ scope:api ; tout le monde → scope:shared
 * - aucun projet Raijin → scope:bench (seul scope:bench peut dépendre de scope:bench)
 */
const depConstraints = [
  // --- Scopes ---
  { sourceTag: 'scope:web', onlyDependOnLibsWithTags: ['scope:web', 'scope:shared'] },
  { sourceTag: 'scope:api', onlyDependOnLibsWithTags: ['scope:api', 'scope:shared'] },
  { sourceTag: 'scope:landing', onlyDependOnLibsWithTags: ['scope:landing', 'scope:shared'] },
  { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
  { sourceTag: 'scope:bench', onlyDependOnLibsWithTags: ['scope:bench', 'scope:shared'] },
  // --- Types ---
  {
    sourceTag: 'type:app',
    onlyDependOnLibsWithTags: ['type:feature', 'type:ui', 'type:data-access', 'type:util', 'type:contracts', 'type:brand'],
  },
  {
    sourceTag: 'type:feature',
    onlyDependOnLibsWithTags: ['type:feature', 'type:ui', 'type:data-access', 'type:util', 'type:contracts', 'type:brand'],
  },
  { sourceTag: 'type:ui', onlyDependOnLibsWithTags: ['type:ui', 'type:util', 'type:brand'] },
  { sourceTag: 'type:data-access', onlyDependOnLibsWithTags: ['type:data-access', 'type:util', 'type:contracts'] },
  { sourceTag: 'type:util', onlyDependOnLibsWithTags: ['type:util', 'type:contracts'] },
  { sourceTag: 'type:contracts', onlyDependOnLibsWithTags: ['type:contracts', 'type:util'] },
  { sourceTag: 'type:brand', onlyDependOnLibsWithTags: [] },
];

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/.astro', '**/vite.config.*.timestamp*', '**/vitest.config.*.timestamp*'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mts', '**/*.cts', '**/*.mjs', '**/*.cjs'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          banTransitiveDependencies: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints,
        },
      ],
    },
  },
];
