import { Reflector } from '@nestjs/core';
import { ROLES_KEY, RolesGuard } from '@raijin/api-auth';
import type { PrismaService } from '@raijin/api-prisma';
import type { ExecutionContext } from '@nestjs/common';
import { TrialAdminController, TrialController, TrialInternalController } from './trial.controller';
import type { TrialConversionService } from './trial-conversion.service';
import type { TrialLifecycleService } from './trial-lifecycle.service';
import type { TrialRecapService } from './trial-recap.service';

const auth = { userId: '01968b3a-7c2e-7d4a-9f00-000000000001', sessionId: 's', role: 'USER' as const, accessTokenExpiresAt: new Date() };

describe('TrialController', () => {
  it('recap et end-screen/seen pour l’utilisateur de la session seulement', async () => {
    const recaps = { recap: jest.fn(async () => ({ analysesCount: 1 })) };
    const lifecycle = { markEndScreenSeen: jest.fn(async () => undefined) };
    const controller = new TrialController(recaps as unknown as TrialRecapService, lifecycle as unknown as TrialLifecycleService);
    await controller.recap(auth);
    expect(recaps.recap).toHaveBeenCalledWith(auth.userId);
    await controller.endScreenSeen(auth);
    expect(lifecycle.markEndScreenSeen).toHaveBeenCalledWith(auth.userId);
  });
});

describe('TrialAdminController', () => {
  it('réservé au rôle ADMIN (métadonnée lue par RolesGuard, rôle relu en base)', async () => {
    expect(Reflect.getMetadata(ROLES_KEY, TrialAdminController)).toEqual(['ADMIN']);
    const conversion = { report: jest.fn(async () => ({ totals: {} })) };
    await new TrialAdminController(conversion as unknown as TrialConversionService).report();
    expect(conversion.report).toHaveBeenCalled();

    const prisma = { user: { findUnique: jest.fn(async (): Promise<{ role: string } | null> => ({ role: 'USER' })) } };
    const guard = new RolesGuard(new Reflector(), prisma as unknown as PrismaService);
    const context = {
      getHandler: () => TrialAdminController.prototype.report,
      getClass: () => TrialAdminController,
      switchToHttp: () => ({ getRequest: () => ({ auth: { ...auth, role: 'ADMIN' } }) }),
    } as unknown as ExecutionContext;
    // Jeton marqué ADMIN mais rôle USER en base : refusé.
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    prisma.user.findUnique.mockResolvedValueOnce({ role: 'ADMIN' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const anonymous = { ...context, switchToHttp: () => ({ getRequest: () => ({}) }) } as unknown as ExecutionContext;
    await expect(guard.canActivate(anonymous)).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
    const open = { ...context, getHandler: () => TrialController.prototype.recap, getClass: () => TrialController } as unknown as ExecutionContext;
    await expect(guard.canActivate(open)).resolves.toBe(true);
  });
});

describe('TrialInternalController (horloge simulée)', () => {
  function setup(enabled = true) {
    const lifecycle = {
      assertTestClock: jest.fn(() => {
        if (!enabled) throw Object.assign(new Error('404'), { code: 'NOT_FOUND' });
      }),
      tick: jest.fn(async () => ({ expired: 1 })),
    };
    return { lifecycle, controller: new TrialInternalController(lifecycle as unknown as TrialLifecycleService) };
  }

  it('exécute le job à l’instant donné ; corps invalide ou trop loin : 400 ; désactivé : 404', async () => {
    const { controller, lifecycle } = setup();
    const now = new Date(Date.now() + 8 * 86_400_000).toISOString();
    expect(await controller.tick({ now })).toEqual({ expired: 1 });
    expect(lifecycle.tick).toHaveBeenCalledWith(new Date(now), undefined);
    await controller.tick({ now, userId: auth.userId });
    expect(lifecycle.tick).toHaveBeenLastCalledWith(new Date(now), auth.userId);
    await expect(controller.tick({ now, userId: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(controller.tick({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(controller.tick({ now, extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(controller.tick({ now: new Date(Date.now() + 500 * 86_400_000).toISOString() })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(setup(false).controller.tick({ now })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
