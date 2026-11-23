import { PUSH_SERVICE_HOSTS, pushEndpointSchema, type PushNotificationPayload } from '@raijin/shared-contracts';
import { sendNotification, WebPushError, type RequestOptions } from 'web-push';
import { PushSender, type PushResult, type PushSendOptions, type PushTarget } from './push-sender';

/** Délai maximal d'un envoi au service push. */
export const PUSH_TIMEOUT_MS = 5_000;

export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

type SendFn = typeof sendNotification;

/**
 * Envoi réel via `web-push` (partagé par les deux API, docs/ARCHITECTURE.md §17.1 ; la paire VAPID est fournie par l'appelant) (chiffrement aes128gcm, en-têtes VAPID). La clé privée ne sort jamais
 * de cette classe ; l'endpoint est revalidé contre `PUSH_SERVICE_HOSTS` avant chaque envoi
 * (défense en profondeur contre une ligne altérée en base : pas de SSRF) et n'est jamais journalisé.
 */
export class WebPushSender extends PushSender {
  readonly configured: boolean;
  readonly publicKey: string | null;

  constructor(
    private readonly keys: VapidKeys | null,
    private readonly sendFn: SendFn = sendNotification,
  ) {
    super();
    this.configured = keys !== null;
    this.publicKey = keys?.publicKey ?? null;
  }

  async send(target: PushTarget, payload: PushNotificationPayload, options: PushSendOptions): Promise<PushResult> {
    if (!this.keys) return { status: 'failed', code: 'PUSH_NOT_CONFIGURED' };
    if (!pushEndpointSchema.safeParse(target.endpoint).success) return { status: 'gone' };
    const request: RequestOptions = {
      vapidDetails: { subject: this.keys.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
      TTL: options.ttlSeconds,
      urgency: options.urgency,
      timeout: PUSH_TIMEOUT_MS,
      contentEncoding: 'aes128gcm',
    };
    try {
      await this.sendFn({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(payload), request);
      return { status: 'sent' };
    } catch (error) {
      if (error instanceof WebPushError) {
        if (error.statusCode === 404 || error.statusCode === 410) return { status: 'gone' };
        return { status: 'failed', code: `HTTP_${error.statusCode}` };
      }
      // Message jamais repris : il peut contenir l'endpoint.
      const code = (error as { code?: unknown } | null)?.code;
      return { status: 'failed', code: typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'PUSH_ERROR' };
    }
  }
}

/** Hôtes autorisés (réexportés pour les tests de sécurité). */
export const ALLOWED_PUSH_HOSTS = PUSH_SERVICE_HOSTS;
