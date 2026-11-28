/**
 * Réglages de processus du scan porté (remplacent `Deno.env.get` et l'envoi VAPID intégré de l'Edge Function) :
 * installés par le job `scan-tokens` avant chaque exécution (une seule à la fois : verrou BullMQ).
 * - `env` : variables d'origine (`JUP_API_BASE`, `JUP_API_KEY`, `MIN_MARKET_CAP`, `MIN_LIQUIDITY`, `SCAN_KEYWORDS`),
 *   lues dans les `BENCH_*` du banc ;
 * - `push` : envoi par `@raijin/server-push` via `BenchNotifier` ; `null` = push indisponible **ou mode ombre**
 *   (même effet qu'une paire VAPID absente sous Supabase : aucune alerte envoyée, donc aucune ligne `alert_log`) ;
 * - `autoPaperAllowed` : `BenchModeService.autoPaperAllowed()` (faux en mode ombre : aucune position auto-paper).
 */
export interface ScanPushPort {
  send(
    sub: { readonly endpoint: string; readonly p256dh: string; readonly auth: string },
    payload: string,
    options: { readonly timeoutMs: number },
  ): Promise<{ readonly ok: boolean; readonly gone: boolean }>;
}

export interface ScanRuntime {
  readonly env: (name: string) => string | undefined;
  readonly push: ScanPushPort | null;
  readonly autoPaperAllowed: () => boolean;
}

const DEFAULT_RUNTIME: ScanRuntime = { env: () => undefined, push: null, autoPaperAllowed: () => false };
let current: ScanRuntime = DEFAULT_RUNTIME;

export function setScanRuntime(runtime: ScanRuntime | null): void {
  current = runtime ?? DEFAULT_RUNTIME;
}

export function scanRuntime(): ScanRuntime {
  return current;
}
