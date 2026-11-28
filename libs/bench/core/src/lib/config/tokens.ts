/** Jetons d'injection du socle du banc. */
export const BENCH_CONFIG = Symbol('BENCH_CONFIG');
/** Horloge injectable (`() => Date`) : les tests d'expiration avancent le temps sans attendre. */
export const BENCH_CLOCK = Symbol('BENCH_CLOCK');
/** Version affichée par `GET /api/status` (fournie par l'application). */
export const BENCH_VERSION = Symbol('BENCH_VERSION');
/** Intégrations Solana du banc (`createBenchSolana`, `@raijin/bench-solana`), une instance par processus. */
export const BENCH_SOLANA = Symbol('BENCH_SOLANA');

export type BenchClock = () => Date;
export const SYSTEM_BENCH_CLOCK: BenchClock = () => new Date();
