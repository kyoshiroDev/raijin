/** Paramètres de connexion fournis par l'application (bench-core lit `BENCH_DATABASE_URL`). */
export interface BenchPrismaOptions {
  /** URL Postgres de `raijin_bench` (utilisateur `raijin_bench`) : jamais journalisée. */
  readonly databaseUrl: string;
}

export const BENCH_PRISMA_OPTIONS = Symbol('BENCH_PRISMA_OPTIONS');

/**
 * Code d'erreur sûr à journaliser : le message d'un pilote Postgres peut contenir l'URL de
 * connexion (donc le mot de passe), seul le code est gardé.
 */
export function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code))
      return code;
  }
  return 'UNKNOWN';
}
