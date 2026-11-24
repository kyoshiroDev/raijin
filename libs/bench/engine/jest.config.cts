module.exports = {
  displayName: 'bench-engine',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json', diagnostics: { exclude: ['**/src/ported/**'] } }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // Tests d'origine de `_shared` (Deno) exécutés tels quels : `node:test` → adaptateur Jest.
  // Les tests d'origine n'étaient pas vérifiés par tsc (seules les fonctions l'étaient) : diagnostics coupés sur ported/.
  moduleNameMapper: { '^node:test$': '<rootDir>/src/testing/node-test-shim.ts' },
  coverageDirectory: '../../../coverage/libs/bench/engine',
  // Aucun appel réseau : `fetch` simulé par les fixtures enregistrées (`src/ported/test-support`).
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/index.ts', '!src/testing/**', '!src/ported/test-support/**'],
};
