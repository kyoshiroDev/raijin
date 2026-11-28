import type { PushNotificationPayload } from '@raijin/shared-contracts';
import { generateVAPIDKeys, WebPushError } from 'web-push';
import { FakePushSender } from './fake-push.sender';
import { PushSender } from './push-sender';
import { PUSH_TIMEOUT_MS, WebPushSender } from './web-push.sender';

const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: `B${'A'.repeat(86)}`, auth: 'a'.repeat(22) };
const options = { ttlSeconds: 3_600, urgency: 'normal' as const };
const payload: PushNotificationPayload = {
  notification: {
    title: 'Titre',
    body: 'Corps',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: 'test',
    data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/' } } },
  },
} as PushNotificationPayload;

describe('WebPushSender (paire VAPID fournie par l’appelant)', () => {
  const keys = { ...generateVAPIDKeys(), subject: 'mailto:test@example.org' };

  it('envoi : charge JSON, VAPID, TTL, urgence, délai, aes128gcm', async () => {
    const send = jest.fn(async () => ({ statusCode: 201, body: '', headers: {} }));
    const sender = new WebPushSender(keys, send as never);
    expect(sender).toBeInstanceOf(PushSender);
    expect(await sender.send(target, payload, options)).toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledWith(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      expect.objectContaining({ TTL: 3_600, urgency: 'normal', timeout: PUSH_TIMEOUT_MS, contentEncoding: 'aes128gcm', vapidDetails: keys }),
    );
    expect(sender.configured).toBe(true);
    expect(sender.publicKey).toBe(keys.publicKey);
  });

  it('410 → gone, 500 → code seulement, code réseau non conforme → PUSH_ERROR', async () => {
    const gone = new WebPushSender(keys, (async () => Promise.reject(new WebPushError('Gone', 410, {}, '', target.endpoint))) as never);
    expect(await gone.send(target, payload, options)).toEqual({ status: 'gone' });
    const failing = new WebPushSender(keys, (async () => Promise.reject(new WebPushError('Server', 500, {}, '', target.endpoint))) as never);
    expect(await failing.send(target, payload, options)).toEqual({ status: 'failed', code: 'HTTP_500' });
    const odd = new WebPushSender(keys, (async () => Promise.reject(Object.assign(new Error(target.endpoint), { code: 'bad code with spaces' }))) as never);
    const failure = await odd.send(target, payload, options);
    expect(failure).toEqual({ status: 'failed', code: 'PUSH_ERROR' });
    expect(JSON.stringify(failure)).not.toContain('fcm.googleapis.com');
  });

  it('endpoint hors des services push connus : jamais contacté ; sans clés : non configuré', async () => {
    const send = jest.fn();
    expect(await new WebPushSender(keys, send as never).send({ ...target, endpoint: 'https://169.254.169.254/x' }, payload, options)).toEqual({ status: 'gone' });
    expect(send).not.toHaveBeenCalled();
    const none = new WebPushSender(null);
    expect(none.configured).toBe(false);
    expect(none.publicKey).toBeNull();
    expect(await none.send(target, payload, options)).toEqual({ status: 'failed', code: 'PUSH_NOT_CONFIGURED' });
  });
});

describe('FakePushSender', () => {
  it('enregistre sans réseau (empreinte d’endpoint), simule /gone et /fail, borne et vide', async () => {
    const fake = new FakePushSender(null);
    expect(fake.configured).toBe(false);
    for (let index = 0; index < 501; index += 1) await fake.send(target, payload, options);
    expect(fake.sent()).toHaveLength(500);
    expect(JSON.stringify(fake.sent())).not.toContain(target.endpoint);
    expect(await fake.send({ ...target, endpoint: 'https://fcm.googleapis.com/gone/1' }, payload, options)).toEqual({ status: 'gone' });
    expect(await fake.send({ ...target, endpoint: 'https://fcm.googleapis.com/fail/1' }, payload, options)).toEqual({ status: 'failed', code: 'HTTP_503' });
    fake.clear();
    expect(fake.sent()).toHaveLength(0);
  });
});
