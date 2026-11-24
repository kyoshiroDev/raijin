import { Injectable, computed, inject, signal } from '@angular/core';
import type { AnalysisResult, QuotaInfo } from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import type { ClientError } from '../http/api-error';
import { AnalysisApi } from './analysis-api';
import { AnalysisPrefetch } from './analysis-prefetch';
import { readAnalysisResponse, readAnalysisResult } from './analysis-shape';
import { runWhenIdle } from '../util/idle';

/** Égalité de données JSON (ordre des clés indifférent ; une clé `undefined` vaut une clé absente). */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameData(item, b[i]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameData(left[key], right[key])) return false;
  }
  return true;
}

/**
 * - `idle` : rien de demandé (état vide de l'écran) ;
 * - `loading` : analyse ou lecture en cours ;
 * - `ready` : résultat disponible ;
 * - `error` : échec, `error()` porte le code et le message à afficher.
 */
export type AnalysisStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Store d'une analyse (signals). Fourni au niveau des routes : l'écran d'analyse et la page
 * publique ont chacun le leur. Une réponse arrivée après une demande plus récente est ignorée.
 * Aucun import de valeur depuis les contrats : les schémas Zod restent hors du chemin critique
 * (validation via `loadContracts`, traduction des erreurs chargée à la demande).
 */
@Injectable()
export class AnalysisStore {
  private readonly api = inject(AnalysisApi);
  private readonly prefetch = inject(AnalysisPrefetch);
  private sequence = 0;
  private quotaRequest: Promise<void> | null = null;

  private readonly currentStatus = signal<AnalysisStatus>('idle');
  private readonly currentResult = signal<AnalysisResult | null>(null);
  private readonly currentError = signal<ClientError | null>(null);
  private readonly currentQuota = signal<QuotaInfo | null>(null);

  readonly status = this.currentStatus.asReadonly();
  readonly result = this.currentResult.asReadonly();
  readonly error = this.currentError.asReadonly();
  readonly quota = this.currentQuota.asReadonly();
  readonly loading = computed(() => this.currentStatus() === 'loading');
  /** Quota épuisé (réponse `QUOTA_EXCEEDED` ou quota connu à 0). */
  readonly quotaExhausted = computed(
    () => this.currentError()?.code === 'QUOTA_EXCEEDED' || this.currentQuota()?.remaining === 0,
  );

  /** Lance l'analyse d'une saisie (mint ou lien). Résout `true` si un résultat est arrivé. */
  async analyze(input: string): Promise<boolean> {
    const id = this.begin();
    const trimmed = input.trim();
    try {
      // Requête lancée au démarrage sur `/analyse/<mint>` (même saisie) : réutilisée, jamais rejouée.
      const body = await firstValueFrom(this.prefetch.take(trimmed) ?? this.api.analyze({ input: trimmed }));
      if (id !== this.sequence) return false;
      // Affichage d'abord (contrôle de forme), validation complète par les contrats ensuite.
      const response = readAnalysisResponse(body);
      this.currentQuota.set(response.quota);
      this.succeed(response.analysis);
      this.validateWhenIdle(id, () => this.api.validateResponse(body), (valid) => {
        this.currentQuota.set(valid.quota);
        this.replaceIfChanged(valid.analysis);
      });
      return true;
    } catch (error) {
      if (id !== this.sequence) return false;
      await this.fail(error, id, true);
      return false;
    }
  }

  /** Lit la dernière analyse publiée d'un mint (page publique `/t/<mint>`, sans quota). */
  async loadLatest(mint: string): Promise<boolean> {
    const id = this.begin();
    try {
      // Lecture lancée avec le HTML (`analyse-prefetch.js`) : reprise, jamais rejouée.
      const body = await firstValueFrom(this.prefetch.takeLatest(mint) ?? this.api.latest(mint));
      if (id !== this.sequence) return false;
      this.succeed(readAnalysisResult(body));
      this.validateWhenIdle(id, () => this.api.validateResult(body), (valid) => this.replaceIfChanged(valid));
      return true;
    } catch (error) {
      if (id !== this.sequence) return false;
      await this.fail(error, id);
      return false;
    }
  }

  /**
   * Rafraîchit le quota restant (discret : un échec n'affiche rien). Une seule requête à la fois :
   * les appels concurrents (écran, erreur d'analyse) partagent la même.
   */
  refreshQuota(): Promise<void> {
    this.quotaRequest ??= firstValueFrom(this.api.quota())
      .then(
        (quota) => this.currentQuota.set(quota),
        () => undefined, // Information d'appoint : l'API le renverra avec la prochaine analyse.
      )
      .finally(() => (this.quotaRequest = null));
    return this.quotaRequest;
  }

  /** Affiche une erreur locale sans appel réseau (ex. adresse invalide dans l'URL). */
  setLocalError(error: ClientError): void {
    this.sequence++;
    this.currentResult.set(null);
    this.currentError.set(error);
    this.currentStatus.set('error');
  }

  /** Retour à l'état vide (nouvelle saisie). */
  reset(): void {
    this.sequence++;
    this.currentResult.set(null);
    this.currentError.set(null);
    this.currentStatus.set('idle');
  }

  /**
   * Validation complète par les contrats (chunk Zod chargé à ce moment-là), à l'inactivité du
   * navigateur, donc après l'affichage du verdict. Valide : le résultat nettoyé remplace l'affiché.
   * Rejetée : l'écran repasse en état d'erreur (`INTERNAL_ERROR`). Ignorée si une demande plus
   * récente a eu lieu entre-temps.
   */
  private validateWhenIdle<T>(id: number, validate: () => Promise<T>, apply: (valid: T) => void): void {
    runWhenIdle(() => {
      validate().then(
        (valid) => {
          if (id === this.sequence) apply(valid);
        },
        (error: unknown) => {
          if (id === this.sequence) void this.fail(error, id);
        },
      );
    });
  }

  /**
   * Résultat validé : remplace l'affiché seulement s'il diffère (champs nettoyés ou retirés). Identique (cas
   * normal), l'écran n'est pas rendu une seconde fois : pas de long travail après le verdict (TBT, §10.6).
   */
  private replaceIfChanged(valid: AnalysisResult): void {
    const shown = this.currentResult();
    if (shown && sameData(shown, valid)) return;
    this.currentResult.set(valid);
  }

  private begin(): number {
    this.currentError.set(null);
    this.currentStatus.set('loading');
    return ++this.sequence;
  }

  private succeed(result: AnalysisResult): void {
    this.currentResult.set(result);
    this.currentStatus.set('ready');
  }

  private async fail(error: unknown, id: number, withQuota = false): Promise<void> {
    const { toAnalysisError } = await import('./analysis-errors');
    if (id !== this.sequence) return;
    const clientError = toAnalysisError(error);
    if (clientError.code === 'QUOTA_EXCEEDED') {
      this.currentQuota.update((quota) => (quota ? { ...quota, remaining: 0, used: quota.limit ?? quota.used } : quota));
    } else if (withQuota && !this.currentQuota()) {
      // Une erreur ne porte pas le quota : on le demande (une fois) pour l'afficher quand même.
      void this.refreshQuota();
    }
    this.currentResult.set(null);
    this.currentError.set(clientError);
    this.currentStatus.set('error');
  }
}
