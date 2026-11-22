import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ADMIN_STAGE_KEY, AdminGuard, AuthGuard } from '@raijin/api-auth';
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
  it('sous @AdminRoute() (AuthGuard puis AdminGuard, session admin complète) : non-admin → 404 par AdminGuard', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, TrialAdminController)).toEqual([AuthGuard, AdminGuard]);
    expect(Reflect.getMetadata(ADMIN_STAGE_KEY, TrialAdminController)).toBe('full');
    const conversion = { report: jest.fn(async () => ({ totals: {} })) };
    await new TrialAdminController(conversion as unknown as TrialConversionService).report();
    expect(conversion.report).toHaveBeenCalled();
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
