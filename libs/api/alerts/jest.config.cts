module.exports = {
  displayName: 'api-alerts',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../../coverage/libs/api/alerts',
  collectCoverageFrom: ['src/lib/**/*.ts', '!src/**/*.spec.ts'],
  // Phase 4 : au moins 80 % sur les suivis, alertes, planificateur et idempotence (comme api-auth).
  coverageThreshold: { global: { statements: 80, branches: 80, functions: 80, lines: 80 } },
};
