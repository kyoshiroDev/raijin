module.exports = {
  displayName: 'bench-solana',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../../coverage/libs/bench/solana',
  // Aucun appel réseau : `fetch` et Redis simulés.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/index.ts', '!src/test/**'],
  collectCoverage: true,
  coverageReporters: ['text-summary', 'text'],
  coverageThreshold: { global: { lines: 90, branches: 85, functions: 90, statements: 90 } },
};
