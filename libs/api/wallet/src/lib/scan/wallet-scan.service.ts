import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AnalysisClock, KeyValueStore, UpstreamUnavailableError } from '@raijin/api-analysis';
import { APP_CONFIG, ApiException, randomToken, type AppConfig } from '@raijin/api-core';
import {
  ANALYSIS_ERROR_MESSAGES,
  knownNonWalletKind,
  WALLET_ERROR_MESSAGES,
  walletAddressSchema,
  walletScanResponseSchema,
  walletScanResultSchema,
  type WalletScanResponse,
  type WalletScanResult,
} from '@raijin/shared-contracts';
import { WalletAccessService } from '../access/wallet-access.service';
import { WalletAddressRejectedError, WalletDataSource, WalletTooLargeError } from '../ports/wallet-data-source';
import { QuickRiskEngine } from './quick-verdict';
import { buildScanResult, planHoldings } from './wallet-result-builder';
import { WalletRepository } from './wallet.repository';
import { walletKey } from './wallet-utils';
import { WalletVerdictsService } from './wallet-verdicts.service';

/** Verrou du scan d'un wallet (une seule collecte à la fois, toutes instances confondues). */
export const WALLET_LOCK_TTL_MS = 20_000;
export const WALLET_WAIT_POLL_MS = 250;
/** Refus définitif d'une adresse (programme, compte de token, mint, wallet trop gros) : 1 h. */
export const WALLET_REJECTED_TTL_MS = 3_600_000;

type WalletErrorCode = 'WALLET_INVALID' | 'WALLET_IS_TOKEN' | 'WALLET_TOO_LARGE';

export function walletError(code: WalletErrorCode): ApiException {
  const status = code === 'WALLET_INVALID' ? HttpStatus.BAD_REQUEST : HttpStatus.UNPROCESSABLE_ENTITY;
  return new ApiException(code, status, WALLET_ERROR_MESSAGES[code]);
}

function upstreamUnavailable(): ApiException {
  return new ApiException('UPSTREAM_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE, ANALYSIS_ERROR_MESSAGES.UPSTREAM_UNAVAILABLE);
}

/**
 * Valide le corps `{ address }` (docs/ARCHITECTURE.md §12.2) : 400 `WALLET_INVALID` (saisie invalide,
 * programme connu, champ inattendu), 422 `WALLET_IS_TOKEN` (mint connu). Aucun appel réseau.
 */
export function parseWalletRequest(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw walletError('WALLET_INVALID');
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'address') throw walletError('WALLET_INVALID');
  const parsed = walletAddressSchema.safeParse((body as { address: unknown }).address);
  if (!parsed.success) throw walletError('WALLET_INVALID');
  const known = knownNonWalletKind(parsed.data);
  if (known === 'mint') throw walletError('WALLET_IS_TOKEN');
  if (known === 'program') throw walletError('WALLET_INVALID');
  return parsed.data;
}

interface Computed {
  readonly result: WalletScanResult;
  readonly credits: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Orchestration du scan de wallet en **lecture seule** (docs/ARCHITECTURE.md §12) : droits relus en
 * base → schéma → refus en cache → cache du wallet → quota réservé → single-flight + verrou →
 * `listHoldings` → tri, poussière, plafond → verdicts (réutilisation, cache, lot rapide) → résultat
 * contractuel → cache Redis court sous clé HMAC → `ProductEvent` sans adresse.
 * Aucune adresse n'est écrite en base ni dans les journaux.
 */
@Injectable()
export class WalletScanService {
  private readonly logger = new Logger('WalletScan');
  private readonly inflight = new Map<string, Promise<Computed>>();
  /** Réglages d'attente d'une autre instance (surchargés par les tests). */
  waitPollMs = WALLET_WAIT_POLL_MS;

  constructor(
    private readonly access: WalletAccessService,
    private readonly source: WalletDataSource,
    private readonly verdicts: WalletVerdictsService,
    private readonly engine: QuickRiskEngine,
    private readonly store: KeyValueStore,
    private readonly repository: WalletRepository,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Durée du cache du résultat : plus longue sans clé Helius (RPC public lent), 10 min au plus. */
  get cacheTtlMs(): number {
    const { cacheTtlS, cacheTtlNoKeyS } = this.config.wallet;
    return Math.min(600, this.source.heliusConfigured ? cacheTtlS : cacheTtlNoKeyS) * 1000;
  }

  /** Tokens analysés au plus par scan (8 sans clé Helius). */
  get maxTokens(): number {
    return this.source.heliusConfigured ? this.config.wallet.maxTokens : this.config.wallet.maxTokensNoKey;
  }

  /** `POST wallet-scans`. */
  async scan(userId: string, body: unknown): Promise<WalletScanResponse> {
    const started = performance.now();
    // Échéance globale fixée à l'arrivée : l'attente d'un verrou détenu ailleurs en est déduite.
    const deadlineAt = Date.now() + this.config.wallet.deadlineMs;
    const rights = await this.access.requireAllowed(userId);
    const address = parseWalletRequest(body);
    const key = walletKey(this.config.analysis.ipHashSecret, address);
    await this.throwIfRejected(key);
    const cached = await this.readCache(key, address);
    const reservation = await this.access.reserve(rights.policy, key);

    let computed: Computed;
    try {
      computed = cached ? { result: cached, credits: 0 } : await this.getOrCompute(address, key, deadlineAt);
    } catch (failure) {
      await this.access.settleFailure(reservation, failure);
      throw failure;
    }
    // `cached: true` seulement pour un re-scan du même utilisateur (déjà compté dans la fenêtre
    // `quota:seen`) : sinon, il révélerait qu'un autre compte vient de scanner ce wallet.
    const sameUserRescan = !reservation.counted;
    // Garde de sortie : rien ne sort de l'API hors contrat.
    const response = walletScanResponseSchema.parse({
      scan: { ...computed.result, cached: computed.result.cached && sameUserRescan },
      quota: await this.access.info(rights.policy, reservation.used),
    });
    const durationMs = performance.now() - started;
    const { summary } = response.scan;
    await this.repository.recordScan({
      userId,
      tokenCount: summary.tokenCount,
      analyzedCount: summary.analyzedCount,
      delegationCount: summary.delegationCount,
      cached: response.scan.cached,
      partial: response.scan.partial,
      durationMs,
      credits: computed.credits,
      plan: rights.plan,
      trialActive: rights.trialActive,
    });
    // Journal sans adresse (ni tronquée), sans mint ni délégué.
    this.logger.log(
      `Scan de wallet ${response.scan.cached ? 'en cache' : 'frais'} en ${Math.round(durationMs)} ms ` +
        `(${summary.tokenCount} tokens, ${summary.analyzedCount} analysés, ${summary.delegationCount} délégations, ${computed.credits} crédits)`,
    );
    return response;
  }

  private scanKey(key: string): string {
    return `wallet:scan:${this.engine.version}:${key}`;
  }

  /** Résultat en cache ; l'adresse, absente de la valeur stockée, est remise depuis la requête. */
  private async readCache(key: string, address: string): Promise<WalletScanResult | null> {
    const raw = await this.store.get(this.scanKey(key));
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as Record<string, unknown>;
      const parsed = walletScanResultSchema.safeParse({ ...stored, address });
      return parsed.success ? { ...parsed.data, cached: true } : null;
    } catch {
      return null;
    }
  }

  private async throwIfRejected(key: string): Promise<void> {
    const code = await this.store.get(`wallet:rejected:${key}`);
    if (code === 'WALLET_INVALID' || code === 'WALLET_IS_TOKEN' || code === 'WALLET_TOO_LARGE') throw walletError(code);
  }

  private async getOrCompute(address: string, key: string, deadlineAt: number): Promise<Computed> {
    const running = this.inflight.get(key);
    if (running) {
      const shared = await running;
      return { result: { ...shared.result, cached: true }, credits: 0 };
    }
    const promise = this.computeWithLock(address, key, deadlineAt).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async computeWithLock(address: string, key: string, deadlineAt: number): Promise<Computed> {
    const lockKey = `wallet:lock:${key}`;
    const token = randomToken(12);
    const acquired = await this.store.setIfAbsent(lockKey, token, WALLET_LOCK_TTL_MS);
    if (acquired === false) {
      // Une autre instance scanne ce wallet : relecture du cache jusqu'à l'échéance (le temps
      // d'attente est pris sur l'échéance du scan), puis calcul avec le temps restant.
      while (Date.now() < deadlineAt) {
        await sleep(this.waitPollMs);
        const hit = await this.readCache(key, address);
        if (hit) return { result: hit, credits: 0 };
        await this.throwIfRejected(key);
      }
    }
    try {
      return await this.compute(address, key, deadlineAt);
    } finally {
      if (acquired) await this.store.deleteIfEquals(lockKey, token);
    }
  }

  private async compute(address: string, key: string, deadlineAt: number): Promise<Computed> {
    const { maxAccounts, priceLookupMax, dustUsd } = this.config.wallet;
    // Échéance propagée à la lecture des comptes (annulation des appels en cours).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
    let holdings;
    try {
      holdings = await this.source.listHoldings(address, { maxAccounts, priceLookupMax, dustUsd, signal: controller.signal });
    } catch (failure) {
      throw await this.mapListFailure(controller.signal.aborted ? new UpstreamUnavailableError() : failure, key);
    } finally {
      clearTimeout(timer);
    }
    const plan = planHoldings(holdings.tokens, this.maxTokens, dustUsd);
    const resolved = await this.verdicts.resolve(plan.toAnalyze, deadlineAt);
    const result = buildScanResult({
      address,
      holdings,
      plan,
      assessments: resolved.assessments,
      engineVersion: this.engine.version,
      scannedAt: this.clock.now(),
      partial: resolved.partial,
    });
    // Valeur stockée **sans l'adresse** (seule l'empreinte HMAC figure dans la clé).
    const stored: Partial<WalletScanResult> = { ...result };
    delete stored.address;
    await this.store.set(this.scanKey(key), JSON.stringify(stored), this.cacheTtlMs);
    return { result, credits: holdings.credits + resolved.credits };
  }

  private async mapListFailure(failure: unknown, key: string): Promise<unknown> {
    let code: WalletErrorCode | null = null;
    if (failure instanceof WalletAddressRejectedError) code = failure.kind === 'token' ? 'WALLET_IS_TOKEN' : 'WALLET_INVALID';
    else if (failure instanceof WalletTooLargeError) code = 'WALLET_TOO_LARGE';
    if (code) {
      await this.store.set(`wallet:rejected:${key}`, code, WALLET_REJECTED_TTL_MS);
      return walletError(code);
    }
    if (failure instanceof UpstreamUnavailableError) return upstreamUnavailable();
    return failure;
  }
}
