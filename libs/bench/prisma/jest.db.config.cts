/**
 * Tests sur base réelle (déclencheurs et fonctions SQL des migrations) : cible `bench-prisma:test-db`.
 * Exige BENCH_TEST_DATABASE_URL (base jetable déjà migrée par `migrate deploy`) ; chaque test tourne
 * dans une transaction annulée, aucune donnée ne reste.
 */
module.exports = {
  displayName: 'bench-prisma-db',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.db-spec.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js'],
};
