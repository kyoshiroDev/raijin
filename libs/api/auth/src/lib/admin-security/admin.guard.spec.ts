import type { ExecutionContext } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import { createAdminSecurityDb } from '../../testing/admin-security-fake';
import { AuthGuard } from '../http/auth.guard';
import { ADMIN_STAGE_KEY, AdminGuard, AdminRoute, AdminStageOverride, type AdminStage } from './admin.guard';

const USER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const SESSION = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60';
const T0 = new Date('2026-11-22T10:00:00Z');

function throttler(limitHits = 0): ThrottlerStorage & { increment: jest.Mock } {
  let hits = limitHits;
  return { increment: jest.fn(async () => ({ totalHits: ++hits, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 })) } as unknown as ThrottlerStorage & { increment: jest.Mock };
}

function setup(options: { role?: 'USER' | 'ADMIN'; enrolled?: boolean; verifiedAt?: Date | null; lastSeenAt?: Date | null; suspended?: boolean; hits?: number } = {}) {
  const db = createAdminSecurityDb();
  const enabledAt = options.enrolled === false ? null : T0;
  db.user.rows.push({ id: USER, role: options.role ?? 'ADMIN', suspendedAt: options.suspended ? T0 : null, totpSecret: { enabledAt } });
  db.session.rows.push({ id: SESSION, userId: USER, adminVerifiedAt: options.verifiedAt ?? null, adminLastSeenAt: options.lastSeenAt ?? null });
  const storage = throttler(options.hits ?? 0);
  const guard = new AdminGuard(new Reflector(), db as unknown as PrismaService, storage, testConfig());
  return { db, guard, storage };
}

function context(stage: AdminStage | undefined, auth: unknown = { userId: USER, sessionId: SESSION }) {
  const handler = () => undefined;
  if (stage) Reflect.defineMetadata(ADMIN_STAGE_KEY, stage, handler);
  const req: Record<string, unknown> = { auth };
  const res = { setHeader: jest.fn() };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => handler,
    getClass: () => class Dummy {},
  } as unknown as ExecutionContext;
  return { ctx, req, res };
}

const at = (guard: AdminGuard, now: Date) => jest.spyOn(guard, 'now').mockReturnValue(now);

describe('AdminGuard', () => {
  it('non-admin, compte inconnu ou suspendu : 404 NOT_FOUND (espace invisible), no-store posé', async () => {
    const { guard } = setup({ role: 'USER' });
    const { ctx, res } = context(undefined);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    await expect(setup({ suspended: true }).guard.canActivate(context('enrollment').ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setup().guard.canActivate(context(undefined, { userId: 'inconnu', sessionId: SESSION }).ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('sans identité (AuthGuard absent) : 401', async () => {
    await expect(setup().guard.canActivate(context(undefined, null).ctx)).rejects.toMatchObject({ status: 401 });
  });

  it('2FA non activée : 403 ENROLLMENT_REQUIRED, sauf étape enrollment', async () => {
    const { guard } = setup({ enrolled: false });
    await expect(guard.canActivate(context(undefined).ctx)).rejects.toMatchObject({ code: 'ADMIN_2FA_ENROLLMENT_REQUIRED', status: 403 });
    await expect(guard.canActivate(context('verify').ctx)).rejects.toMatchObject({ code: 'ADMIN_2FA_ENROLLMENT_REQUIRED' });
    await expect(guard.canActivate(context('enrollment').ctx)).resolves.toBe(true);
  });

  it('session non vérifiée : 403 ADMIN_2FA_REQUIRED ; étape verify autorisée', async () => {
    const { guard } = setup();
    await expect(guard.canActivate(context(undefined).ctx)).rejects.toMatchObject({ code: 'ADMIN_2FA_REQUIRED', status: 403 });
    await expect(guard.canActivate(context('verify').ctx)).resolves.toBe(true);
  });

  it('session vérifiée : accès, dernière activité mise à jour au plus une fois par minute', async () => {
    const { guard, db } = setup({ verifiedAt: T0, lastSeenAt: T0 });
    at(guard, new Date(T0.getTime() + 30_000));
    const { ctx, req } = context(undefined);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req['admin']).toEqual({ userId: USER, sessionId: SESSION });
    expect(db.session.rows[0]?.['adminLastSeenAt']).toEqual(T0);
    at(guard, new Date(T0.getTime() + 61_000));
    await guard.canActivate(context(undefined).ctx);
    expect(db.session.rows[0]?.['adminLastSeenAt']).toEqual(new Date(T0.getTime() + 61_000));
  });

  it('30 min d’inactivité : 403 ADMIN_SESSION_EXPIRED, colonnes remises à null', async () => {
    const { guard, db } = setup({ verifiedAt: T0, lastSeenAt: T0 });
    at(guard, new Date(T0.getTime() + 30 * 60_000 + 1));
    await expect(guard.canActivate(context(undefined).ctx)).rejects.toMatchObject({ code: 'ADMIN_SESSION_EXPIRED', status: 403 });
    expect(db.session.rows[0]).toMatchObject({ adminVerifiedAt: null, adminLastSeenAt: null });
    await expect(guard.canActivate(context(undefined).ctx)).rejects.toMatchObject({ code: 'ADMIN_2FA_REQUIRED' });
  });

  it('8 h après la saisie du code : expirée malgré l’activité', async () => {
    const now = new Date(T0.getTime() + 8 * 3_600_000 + 1);
    const { guard } = setup({ verifiedAt: T0, lastSeenAt: new Date(now.getTime() - 60_000) });
    at(guard, now);
    await expect(guard.canActivate(context(undefined).ctx)).rejects.toMatchObject({ code: 'ADMIN_SESSION_EXPIRED' });
  });

  it('throttler admin par utilisateur : 429 au-delà de la limite', async () => {
    const { guard, storage } = setup({ hits: 120 });
    await expect(guard.canActivate(context('enrollment').ctx)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(storage.increment.mock.calls[0]?.[0]).toBe(`admin:u:${USER}`);
  });
});

describe('@AdminRoute()', () => {
  @Controller('admin/exemple')
  @AdminRoute()
  class ExampleController {
    @Get()
    list(): string {
      return 'ok';
    }

    @Get('verify')
    @AdminStageOverride('verify')
    verify(): string {
      return 'ok';
    }
  }

  it('pose AuthGuard puis AdminGuard et l’étape full par défaut ; surcharge par méthode', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ExampleController)).toEqual([AuthGuard, AdminGuard]);
    expect(Reflect.getMetadata(ADMIN_STAGE_KEY, ExampleController)).toBe('full');
    const reflector = new Reflector();
    expect(reflector.getAllAndOverride(ADMIN_STAGE_KEY, [ExampleController.prototype.verify, ExampleController])).toBe('verify');
  });
});
