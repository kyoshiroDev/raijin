module.exports = {
  displayName: 'api-solana',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../../coverage/libs/api/solana',
  // Seuil imposé (aucun appel réseau : tout est rejoué depuis src/fixtures).
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/lib/testing/**', '!src/index.ts'],
  collectCoverage: true,
  coverageReporters: ['text-summary', 'text'],
  coverageThreshold: { global: { lines: 80, branches: 80, functions: 80, statements: 80 } },
};
