import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, ApiException, randomToken, type AppConfig } from '@raijin/api-core';
import {
  ANALYSIS_ERROR_MESSAGES,
  analysisResultSchema,
  type AnalysisResponse,
  type AnalysisResult,
} from '@raijin/shared-contracts';
import { canIssueVerdict } from '@raijin/shared-risk-engine';
import { extractSolanaAddress } from '@raijin/shared-util';
import { AnalysisClock, FactsCollector, UpstreamUnavailableError } from '../ports/facts-collector';
import { QuotaService, type QuotaActor } from '../quota/quota.service';
import { KeyValueStore } from '../store/key-value-store';
import { AnalysisRepository } from './analysis.repository';
import { buildAnalysisResult } from './result-builder';
import { RiskEngine } from './risk-engine.provider';

/** Verrou d'analyse d'un mint (une seule collecte à la fois, toutes instances confondues). */
export const ANALYSIS_LOCK_TTL_MS = 15_000;
/** Attente du résultat d'une autre instance : relecture du cache toutes les 250 ms pendant 10 s. */
export const ANALYSIS_WAIT_POLL_MS = 250;
export const ANALYSIS_WAIT_MAX_MS = 10_000;
/** Cache négatif d'un mint inexistant. */
export const NOT_FOUND_TTL_MS = 60_000;

/** Réponse de `POST /analyses` et durée mesurée (en-tête `Server-Timing`). */
export interface TimedAnalysisResponse {
  readonly response: AnalysisResponse;
  readonly durationMs: number;
}

function error(code: 'MINT_INVALID' | 'TOKEN_NOT_FOUND' | 'ANALYSIS_NOT_FOUND' | 'UPSTREAM_UNAVAILABLE'): ApiException {
  const status = {
    MINT_INVALID: HttpStatus.BAD_REQUEST,
    TOKEN_NOT_FOUND: HttpStatus.NOT_FOUND,
    ANALYSIS_NOT_FOUND: HttpStatus.NOT_FOUND,
    UPSTREAM_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  }[code];
  return new ApiException(code, status, ANALYSIS_ERROR_MESSAGES[code]);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Orchestration de l'analyse (docs/ARCHITECTURE.md §9.1, §9.5) :
 * extraction de l'adresse → quota réservé → résolution paire → mint → cache (60 s, 300 s sans clé
 * Helius) → single-flight mémoire + verrou Redis → `collectFacts` → moteur → résultat contractuel →
 * persistance `TokenAnalysis` + événement `analysis_done`. Quota remboursé si l'analyse échoue.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger('Analysis');
  private readonly inflight = new Map<string, Promise<AnalysisResult>>();
  /** Réglages d'attente (surchargés par les tests). */
  waitPollMs = ANALYSIS_WAIT_POLL_MS;
  waitMaxMs = ANALYSIS_WAIT_MAX_MS;

  constructor(
    private readonly collector: FactsCollector,
    private readonly engine: RiskEngine,
    private readonly store: KeyValueStore,
    private readonly quota: QuotaService,
    private readonly repository: AnalysisRepository,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Durée du cache des résultats : plus longue sans clé Helius (RPC public à 1 req/s). */
  get cacheTtlMs(): number {
    const { cacheTtlS, cacheTtlNoKeyS } = this.config.analysis;
    const helius = this.collector.heliusConfigured ?? this.config.services['helius'] ?? false;
    return (helius ? cacheTtlS : cacheTtlNoKeyS) * 1000;
  }

  /** `POST /analyses` : analyse d'un mint ou d'un lien, quota compris. */
  async analyze(input: string, actor: QuotaActor): Promise<TimedAnalysisResponse> {
    const started = performance.now();
    const extracted = extractSolanaAddress(input);
    if (!extracted) throw error('MINT_INVALID');

    const policy = await this.quota.resolvePolicy(actor);
    const reservation = await this.quota.reserve(policy, extracted.address);
    const userId = actor.kind === 'user' ? actor.userId : null;
    let analysis: AnalysisResult;
    try {
      let mint = extracted.address;
      if (extracted.kind === 'pair_or_mint') {
        const direct = await this.readCache(mint);
        mint = direct ? mint : ((await this.resolveMint(mint)) ?? mint);
      }
      analysis = await this.getOrCompute(mint, userId);
    } catch (failure) {
      await this.quota.settleFailure(reservation, failure);
      throw failure;
    }
    const durationMs = performance.now() - started;
    await this.repository.recordEvent({
      userId,
      mint: analysis.mint,
      verdict: analysis.verdict,
      cached: analysis.cached,
      degraded: analysis.degraded,
      engineVersion: analysis.engineVersion,
      durationMs,
      subject: policy.subject,
    });
    this.logger.log(`Analyse ${analysis.cached ? 'en cache' : 'fraîche'} en ${Math.round(durationMs)} ms`);
    return { response: { analysis, quota: await this.quota.info(policy, reservation.used) }, durationMs };
  }

  /** `GET analyses/:mint/latest` : résultat en cache, sinon dernière analyse de moins de 24 h. */
  async latest(mint: string): Promise<AnalysisResult> {
    const result = await this.findLatest(mint);
    if (!result) throw error('ANALYSIS_NOT_FOUND');
    return result;
  }

  /** Comme `latest`, sans erreur (page publique, image OG). */
  async findLatest(mint: string): Promise<AnalysisResult | null> {
    return (await this.readCache(mint)) ?? (await this.repository.findLatest(mint, this.clock.now()));
  }

  private resultKey(mint: string): string {
    return `analysis:result:${this.engine.version}:${mint}`;
  }

  private async resolveMint(address: string): Promise<string | null> {
    try {
      return await this.collector.resolveMint(address);
    } catch {
      // Résolution impossible : l'adresse est analysée comme un mint (TOKEN_NOT_FOUND si ce n'en est pas un).
      return null;
    }
  }

  /** Résultat en cache (marqué `cached`), revalidé par le contrat. */
  private async readCache(mint: string): Promise<AnalysisResult | null> {
    const raw = await this.store.get(this.resultKey(mint));
    if (!raw) return null;
    try {
      const parsed = analysisResultSchema.safeParse(JSON.parse(raw));
      return parsed.success ? { ...parsed.data, cached: true } : null;
    } catch {
      return null;
    }
  }

  private async getOrCompute(mint: string, userId: string | null): Promise<AnalysisResult> {
    const hit = await this.readCache(mint);
    if (hit) return hit;
    if (await this.store.get(`analysis:notfound:${mint}`)) throw error('TOKEN_NOT_FOUND');

    const running = this.inflight.get(mint);
    if (running) return { ...(await running), cached: true };

    const promise = this.computeWithLock(mint, userId).finally(() => this.inflight.delete(mint));
    this.inflight.set(mint, promise);
    return promise;
  }

  private async computeWithLock(mint: string, userId: string | null): Promise<AnalysisResult> {
    const lockKey = `analysis:lock:${mint}`;
    const token = randomToken(12);
    const acquired = await this.store.setIfAbsent(lockKey, token, ANALYSIS_LOCK_TTL_MS);
    if (acquired === false) {
      const awaited = await this.waitForOtherInstance(mint);
      if (awaited) return awaited;
    }
    try {
      return await this.compute(mint, userId);
    } finally {
      if (acquired) await this.store.deleteIfEquals(lockKey, token);
    }
  }

  /** Une autre instance analyse ce mint : on relit le cache, puis on calcule soi-même. */
  private async waitForOtherInstance(mint: string): Promise<AnalysisResult | null> {
    const deadline = Date.now() + this.waitMaxMs;
    while (Date.now() < deadline) {
      await sleep(this.waitPollMs);
      const hit = await this.readCache(mint);
      if (hit) return hit;
      if (await this.store.get(`analysis:notfound:${mint}`)) throw error('TOKEN_NOT_FOUND');
    }
    return null;
  }

  private async compute(mint: string, userId: string | null): Promise<AnalysisResult> {
    const started = performance.now();
    let collected;
    try {
      collected = await this.collector.collectFacts(mint, { profile: 'full' });
    } catch (failure) {
      if (failure instanceof UpstreamUnavailableError) throw error('UPSTREAM_UNAVAILABLE');
      throw failure;
    }
    if (!collected) {
      await this.store.set(`analysis:notfound:${mint}`, '1', NOT_FOUND_TTL_MS);
      throw error('TOKEN_NOT_FOUND');
    }
    // Autorités inconnues : pas de verdict (docs/SCORING.md, règle D1).
    if (collected.facts.mint !== mint || !canIssueVerdict(collected.facts)) throw error('UPSTREAM_UNAVAILABLE');

    const assessment = this.engine.evaluate(collected.facts);
    const result = buildAnalysisResult(mint, collected, assessment, this.clock.now());
    await this.store.set(this.resultKey(mint), JSON.stringify(result), this.cacheTtlMs);
    await this.repository.save(result, collected, performance.now() - started, userId);
    return result;
  }
}
