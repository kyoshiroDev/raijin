module.exports = {
  displayName: 'api-auth',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../../coverage/libs/api/auth',
  collectCoverageFrom: ['src/lib/**/*.ts', '!src/**/*.spec.ts'],
  // Exigence de la phase 2 : au moins 80 % sur l'auth (services, gardes, CSRF, rotation).
  coverageThreshold: { global: { statements: 80, branches: 80, functions: 80, lines: 80 } },
};
