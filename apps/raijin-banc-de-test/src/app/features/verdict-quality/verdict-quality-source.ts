import { Injectable } from '@angular/core';
import { DEMO_VARIANTS, buildQualityReport, simulateHistory, type QualityReport } from '@raijin/bench-verdicts';

/**
 * Port de l'écran /justesse : fournit le rapport de justesse des verdicts. Implémentation simulée
 * tant que l'API du banc n'existe pas ; remplacée en phase 8 bis par le client HTTP de l'API
 * (auth privée + 2FA), qui renverra le même `QualityReport` calculé sur `raijin_bench`.
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
