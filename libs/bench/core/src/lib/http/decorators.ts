import { SetMetadata } from '@nestjs/common';

export const BENCH_PUBLIC = 'raijin-bench:public';
export const BENCH_SKIP_CSRF = 'raijin-bench:skip-csrf';
export const BENCH_LOGIN_THROTTLE = 'raijin-bench:login-throttle';

/**
 * Route accessible sans session du banc. Réservé à `GET /api/health` et `POST /api/auth/login`
 * (docs/ARCHITECTURE.md §17.7) : toute autre route exige la session (401 sinon).
 */
export const BenchPublic = (): MethodDecorator & ClassDecorator => SetMetadata(BENCH_PUBLIC, true);

/** Écriture sans double-submit CSRF (connexion uniquement : contrôle d'`Origin` maintenu). */
export const BenchSkipCsrf = (): MethodDecorator & ClassDecorator => SetMetadata(BENCH_SKIP_CSRF, true);

/** Limite renforcée par IP (connexion). */
export const BenchLoginThrottle = (): MethodDecorator & ClassDecorator => SetMetadata(BENCH_LOGIN_THROTTLE, true);
