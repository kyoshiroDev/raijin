import { generateVapidKeys, testConfig } from '@raijin/api-core';
import { pushNotificationPayloadSchema } from '@raijin/shared-contracts';
import { WebPushError } from 'web-push';
import { createPushSender } from '../api-notifications.module';
import type { AlertMessage } from '../templates/alert-text';
import { FakePushSender } from './fake-push.sender';
import { buildAlertPushPayload } from './push-payload';
import { WebPushSender } from './web-push.sender';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ID = '01968b3a-7c2e-7d4a-9f00-0123456789ab';
const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: `B${'A'.repeat(86)}`, auth: 'a'.repeat(22) };
const options = { ttlSeconds: 86_400, urgency: 'high' as const };

function alert(overrides: Partial<AlertMessage> = {}): AlertMessage {
  return {
    id: ID,
    mint: MINT,
    severity: 'danger',
    token: { mint: MINT, name: 'Bonk‮', symbol: '<b>BONK</b>', decimals: 5, tokenProgram: 'spl-token', untrusted: true },
    createdAt: new Date('2026-11-22T10:00:00.000Z'),
    type: 'lp_removed',
    payload: { poolAddress: MINT, dex: 'raydium', dropPct: 42.5, liquidityUsdBefore: 1000, liquidityUsdAfter: 575, referenceAt: '2026-11-22T09:00:00.000Z' },
    ...overrides,
  } as AlertMessage;
}

describe('charge utile push (format ngsw)', () => {
  it('conforme au contrat : titre avec gravité, clic vers /alertes?alerte=<id>, tag par mint, aucune donnée de compte', () => {
    const payload = buildAlertPushPayload(alert());
    expect(pushNotificationPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.notification.title).toBe('Raijin : alerte Danger');
    expect(payload.notification.body).toContain('42,5 %');
    expect(payload.notification.body).toContain('non vérifié');
    expect(payload.notification.tag).toBe(`alert:${MINT}`);
    expect(payload.notification.data.onActionClick.default.url).toBe(`/alertes?alerte=${ID}`);
    expect(Array.from(payload.notification.body).length).toBeLessThanOrEqual(240);
  });

  it('texte borné même avec un nom très long', () => {
    const long = buildAlertPushPayload(alert({ severity: 'warn', token: { mint: MINT, name: 'x'.repeat(64), symbol: null, decimals: null, tokenProgram: null, untrusted: true } }));
    expect(long.notification.title).toBe('Raijin : alerte Prudence');
  });
});

describe('WebPushSender', () => {
  const keys = { ...generateVapidKeys(), subject: 'mailto:support@raijinshield.com' };

  it('envoi : clés VAPID, TTL, urgence, délai de 5 s, chiffrement aes128gcm', async () => {
    const send = jest.fn(async () => ({ statusCode: 201, body: '', headers: {} }));
    const sender = new WebPushSender(keys, send as never);
    expect(await sender.send(target, buildAlertPushPayload(alert()), options)).toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledWith(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      expect.any(String),
      expect.objectContaining({ TTL: 86_400, urgency: 'high', timeout: 5_000, contentEncoding: 'aes128gcm', vapidDetails: expect.objectContaining({ subject: keys.subject }) }),
    );
    expect(sender.publicKey).toBe(keys.publicKey);
  });

  it('404 / 410 → abonnement expiré ; autre statut → code seulement, jamais l’endpoint ni la clé', async () => {
    const gone = new WebPushSender(keys, (async () => Promise.reject(new WebPushError('Gone', 410, {}, '', target.endpoint))) as never);
    expect(await gone.send(target, buildAlertPushPayload(alert()), options)).toEqual({ status: 'gone' });
    const notFound = new WebPushSender(keys, (async () => Promise.reject(new WebPushError('Not found', 404, {}, '', target.endpoint))) as never);
    expect(await notFound.send(target, buildAlertPushPayload(alert()), options)).toEqual({ status: 'gone' });
    const failing = new WebPushSender(keys, (async () => Promise.reject(new WebPushError('Server', 500, {}, '', target.endpoint))) as never);
    const result = await failing.send(target, buildAlertPushPayload(alert()), options);
    expect(result).toEqual({ status: 'failed', code: 'HTTP_500' });
    const network = new WebPushSender(keys, (async () => Promise.reject(Object.assign(new Error(`connect ${target.endpoint}`), { code: 'ECONNRESET' }))) as never);
    const failure = await network.send(target, buildAlertPushPayload(alert()), options);
    expect(failure).toEqual({ status: 'failed', code: 'ECONNRESET' });
    expect(JSON.stringify(failure)).not.toContain('fcm.googleapis.com');
    expect(JSON.stringify(failure)).not.toContain(keys.privateKey);
  });

  it('endpoint hors des services push connus (ligne altérée) : jamais contacté', async () => {
    const send = jest.fn();
    const sender = new WebPushSender(keys, send as never);
    expect(await sender.send({ ...target, endpoint: 'https://169.254.169.254/latest' }, buildAlertPushPayload(alert()), options)).toEqual({ status: 'gone' });
    expect(await sender.send({ ...target, endpoint: 'http://fcm.googleapis.com/x' }, buildAlertPushPayload(alert()), options)).toEqual({ status: 'gone' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sans clés : non configuré, aucun envoi', async () => {
    const sender = new WebPushSender(null);
    expect(sender.configured).toBe(false);
    expect(await sender.send(target, buildAlertPushPayload(alert()), options)).toEqual({ status: 'failed', code: 'PUSH_NOT_CONFIGURED' });
  });
});

describe('FakePushSender et choix de l’implémentation', () => {
  it('enregistre sans appel réseau, endpoint réduit à une empreinte ; /gone et /fail simulés', async () => {
    const fake = new FakePushSender('cle');
    await fake.send(target, buildAlertPushPayload(alert()), options);
    expect(await fake.send({ ...target, endpoint: 'https://fcm.googleapis.com/gone/1' }, buildAlertPushPayload(alert()), options)).toEqual({ status: 'gone' });
    expect(await fake.send({ ...target, endpoint: 'https://fcm.googleapis.com/fail/1' }, buildAlertPushPayload(alert()), options)).toMatchObject({ status: 'failed' });
    expect(fake.sent()).toHaveLength(1);
    expect(JSON.stringify(fake.sent())).not.toContain(target.endpoint);
    fake.clear();
    expect(fake.sent()).toHaveLength(0);
  });

  it('fake en dev/test seulement, web-push sinon ; sans clés en production : non configuré', () => {
    expect(createPushSender(testConfig({ PUSH_PROVIDER: 'fake' }))).toBeInstanceOf(FakePushSender);
    expect(createPushSender(testConfig())).toBeInstanceOf(WebPushSender);
    expect(createPushSender(testConfig()).configured).toBe(true);
  });
});
