import { Injectable, inject } from '@angular/core';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { DEMO_VARIANTS, buildQualityReport, simulateHistory, type QualityReport } from '@raijin/bench-verdicts';
import { BenchApi } from '../../core/api/bench-api';

/**
 * Port de l'écran /justesse : fournit le rapport de justesse des verdicts. En production, le rapport est calculé par
 * l'API du banc sur `raijin_bench` (`GET /api/verdicts/quality`, même `QualityReport` que la lib) ; le jeu simulé
 * reste disponible pour les tests et les démonstrations.
 */
export abstract class VerdictQualitySource {
  abstract load(): Promise<QualityReport>;
}

/** Graine et taille du jeu simulé : fixes pour que l'écran soit reproductible. */
export const SIMULATION_SEED = 20_261_123;
export const SIMULATION_SIZE = 600;

/** Données simulées et déterministes (`simulateHistory`) : `report.simulated` vaut toujours `true`. */
@Injectable()
export class SimulatedVerdictQualitySource extends VerdictQualitySource {
  load(): Promise<QualityReport> {
    const history = simulateHistory(SIMULATION_SEED, SIMULATION_SIZE);
    return Promise.resolve(buildQualityReport(history, DEMO_VARIANTS));
  }
}

/** Contrôle de forme minimal d'un `QualityReport` venu de l'API (le calcul lui-même vient de la lib, côté API). */
export function isQualityReport(value: unknown): value is QualityReport {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const count = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  return (
    typeof r['simulated'] === 'boolean' &&
    typeof r['engineVersion'] === 'string' &&
    count(r['records']) &&
    count(r['observations']) &&
    count(r['otherEngineVersions']) &&
    count(r['minSample']) &&
    count(r['minSupport']) &&
    Array.isArray(r['horizons'])
  );
}

/** Rapport réel de l'API du banc ; une réponse de forme inattendue est une erreur (jamais affichée à moitié). */
@Injectable()
export class HttpVerdictQualitySource extends VerdictQualitySource {
  private readonly api = inject(BenchApi);

  async load(): Promise<QualityReport> {
    const body = await this.api.get(BENCH_ROUTES.verdictQuality);
    if (!isQualityReport(body)) throw new Error('Rapport de justesse invalide.');
    return body;
  }
}
