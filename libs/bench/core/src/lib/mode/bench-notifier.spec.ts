import { FakePushSender } from '@raijin/server-push';
import { SpyMailSender, testConfig } from '../../testing/test-app';
import { BenchModeService } from './bench-mode.service';
import { BenchNotifier, NullBenchMailSender } from './bench-notifier';

const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'p', auth: 'a' };
const payload = { title: 'Test', body: 'Corps', url: '/alertes', tag: 'test' } as never;
const options = { ttlSeconds: 60, urgency: 'normal' as const };

describe('mode ombre et notifications', () => {
  function setup(mode: 'shadow' | 'primary') {
    const push = new FakePushSender('BPublic');
    const mail = new SpyMailSender();
    const pushSpy = jest.spyOn(push, 'send');
    const mailSpy = jest.spyOn(mail, 'send');
    const modeService = new BenchModeService(testConfig({ BENCH_MODE: mode }));
    return { notifier: new BenchNotifier(modeService, push, mail), pushSpy, mailSpy, modeService };
  }

  it('shadow : push et e-mail jamais appelés, ouverture automatique paper interdite', async () => {
    const { notifier, pushSpy, mailSpy, modeService } = setup('shadow');
    expect(await notifier.sendPush(target, payload, options)).toEqual({ status: 'suppressed', reason: 'shadow_mode' });
    expect(await notifier.sendMail({ to: 'proprietaire@banc.test', subject: 'Alerte', text: 'Taille' })).toEqual({ status: 'suppressed', reason: 'shadow_mode' });
    expect(pushSpy).not.toHaveBeenCalled();
    expect(mailSpy).not.toHaveBeenCalled();
    expect(modeService.isShadow).toBe(true);
    expect(modeService.autoPaperAllowed()).toBe(false);
    expect(modeService.notificationsAllowed()).toBe(false);
  });

  it('primary : les envois partent', async () => {
    const { notifier, pushSpy, mailSpy, modeService } = setup('primary');
    expect(await notifier.sendPush(target, payload, options)).toEqual({ status: 'sent' });
    expect(await notifier.sendMail({ to: 'proprietaire@banc.test', subject: 'Alerte', text: 'Taille' })).toEqual({ status: 'sent' });
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(mailSpy).toHaveBeenCalledTimes(1);
    expect(modeService.autoPaperAllowed()).toBe(true);
    expect(notifier.pushConfigured).toBe(true);
    expect(notifier.pushPublicKey).toBe('BPublic');
  });

  it('e-mail non branché par défaut', async () => {
    const mail = new NullBenchMailSender();
    expect(mail.configured).toBe(false);
    expect(await mail.send()).toEqual({ status: 'failed', code: 'MAIL_NOT_CONFIGURED' });
  });
});
