import { Inject, Injectable } from '@nestjs/common';
import { benchCookieNames } from '@raijin/bench-contracts';
import type { CookieOptions, Request, Response } from 'express';
import type { BenchConfig } from '../config/bench-config';
import { BENCH_CONFIG } from '../config/tokens';

/**
 * Cookies du banc (`__Host-rjb_session` httpOnly, `__Host-rjb_csrf` lisible par le front ; sans préfixe en
 * HTTP local) : `SameSite=Strict`, `Path=/`, sans `Domain`. Les cookies de Raijin (`rj_*`) ne sont jamais lus.
 */
@Injectable()
export class BenchCookies {
  readonly names: { readonly session: string; readonly csrf: string };

  constructor(@Inject(BENCH_CONFIG) private readonly config: BenchConfig) {
    this.names = benchCookieNames(config.auth.cookieSecure);
  }

  private options(httpOnly: boolean, maxAgeMs?: number): CookieOptions {
    return { httpOnly, secure: this.config.auth.cookieSecure, sameSite: 'strict', path: '/', ...(maxAgeMs === undefined ? {} : { maxAge: Math.max(0, maxAgeMs) }) };
  }

  setSession(res: Response, token: string, maxAgeMs: number): void {
    res.cookie(this.names.session, token, this.options(true, maxAgeMs));
  }

  setCsrf(res: Response, token: string, maxAgeMs: number): void {
    res.cookie(this.names.csrf, token, this.options(false, maxAgeMs));
  }

  clear(res: Response): void {
    res.clearCookie(this.names.session, this.options(true));
    res.clearCookie(this.names.csrf, this.options(false));
  }

  read(req: Request, name: 'session' | 'csrf'): string | null {
    const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
    const value = cookies?.[this.names[name]];
    return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
  }
}
