import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, errorCode, type AppConfig } from '@raijin/api-core';
import { createHash } from 'node:crypto';
import { AnalysisService } from '../analysis/analysis.service';
import { KeyValueStore } from '../store/key-value-store';
import { OgRenderer } from './og-renderer';
import { ogModelFrom, type OgModel } from './og-template';

/** Cache Redis d'une image rendue (1 h). */
export const OG_CACHE_TTL_MS = 3_600_000;
/** Rendus en attente au-delà desquels on sert l'image générique (rendu en concurrence 1). */
export const OG_MAX_PENDING = 8;

export interface OgImage {
  readonly png: Buffer;
  readonly etag: string;
}

/**
 * Image Open Graph d'un mint (docs/ARCHITECTURE.md §9.7) : verdict de la dernière analyse publiée,
 * cache Redis `og:<mint>:<verdict>:<engineVersion>` 1 h, rendu en file de concurrence 1 (le rendu
 * est coûteux en CPU) ; file pleine, rendu impossible ou mint jamais analysé : image générique.
 */
@Injectable()
export class OgImageService {
  private readonly logger = new Logger('OgImage');
  private readonly renderer: OgRenderer;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private genericPng: Promise<Buffer> | null = null;

  constructor(
    private readonly analyses: AnalysisService,
    private readonly store: KeyValueStore,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.renderer = new OgRenderer(config.analysis.ogFontsDir);
  }

  async imageFor(mint: string): Promise<OgImage> {
    const latest = await this.analyses.findLatest(mint);
    if (!latest) return this.wrap(await this.genericImage());
    const key = `og:${mint}:${latest.verdict}:${latest.engineVersion}`;
    const cached = await this.store.get(key);
    if (cached) return this.wrap(Buffer.from(cached, 'base64'));
    if (this.pending >= OG_MAX_PENDING) return this.wrap(await this.genericImage());
    try {
      const png = await this.enqueue(ogModelFrom(latest));
      await this.store.set(key, png.toString('base64'), OG_CACHE_TTL_MS);
      return this.wrap(png);
    } catch (error) {
      this.logger.error(`Rendu de l'image OG impossible (${errorCode(error)})`);
      return this.wrap(await this.genericImage());
    }
  }

  /** Image générique (mint invalide). */
  async generic(): Promise<OgImage> {
    return this.wrap(await this.genericImage());
  }

  /** Image générique de la marque, rendue une fois par processus. */
  genericImage(): Promise<Buffer> {
    if (!this.genericPng) {
      this.genericPng = this.enqueue({ verdict: null, mint: null, name: null }).catch((error: unknown) => {
        this.genericPng = null;
        throw error;
      });
    }
    return this.genericPng;
  }

  private enqueue(model: OgModel): Promise<Buffer> {
    this.pending += 1;
    const run = this.queue.then(() => this.renderer.render(model));
    this.queue = run.catch(() => undefined);
    return run.finally(() => {
      this.pending -= 1;
    });
  }

  private wrap(png: Buffer): OgImage {
    return { png, etag: `"${createHash('sha256').update(png).digest('base64url').slice(0, 27)}"` };
  }
}
