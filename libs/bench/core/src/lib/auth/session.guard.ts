import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { BenchException } from '../http/bench-exception';
import { BENCH_PUBLIC } from '../http/decorators';
import { BenchAuthService } from './auth.service';
import { BenchCookies } from './cookies';
import { attachBenchSession } from './session';

/**
 * Garde globale : toute route exige la session du banc, sauf `@BenchPublic()` (`health`, `auth/login`).
 * Seul le cookie `rjb_session` est lu : un cookie Raijin (`rj_at`, même admin), un en-tête `Authorization`
 * ou tout autre jeton ne vaut rien → 401 `AUTH_SESSION_EXPIRED`.
 */
@Injectable()
export class BenchSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: BenchAuthService,
    private readonly cookies: BenchCookies,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    if (this.reflector.getAllAndOverride<boolean>(BENCH_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const session = await this.auth.validate(this.cookies.read(req, 'session'));
    if (!session) throw BenchException.unauthorized();
    attachBenchSession(req, session);
    return true;
  }
}
