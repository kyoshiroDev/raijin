import { createHash } from 'node:crypto';
import type { PushNotificationPayload } from '@raijin/shared-contracts';
import { PushSender, type PushResult, type PushSendOptions, type PushTarget } from './push-sender';

/** Notification enregistrée par `FakePushSender` (l'endpoint n'est gardé que sous forme d'empreinte). */
export interface RecordedPush {
  readonly endpointHash: string;
  readonly payload: PushNotificationPayload;
  readonly options: PushSendOptions;
  readonly at: string;
}

const MAX_RECORDED = 500;

/**
 * Push simulé (`PUSH_PROVIDER=fake`, tests e2e, refusé en production) : aucune requête réseau,
 * notifications gardées en mémoire. Un endpoint dont le chemin contient `/gone` répond comme un
 * abonnement expiré (410), `/fail` comme une panne passagère.
 */
export class FakePushSender extends PushSender {
  readonly configured: boolean;
  readonly publicKey: string | null;
  private readonly recorded: RecordedPush[] = [];

  constructor(publicKey: string | null) {
    super();
    this.publicKey = publicKey;
    this.configured = publicKey !== null;
  }

  async send(target: PushTarget, payload: PushNotificationPayload, options: PushSendOptions): Promise<PushResult> {
    const path = new URL(target.endpoint).pathname;
    if (path.includes('/gone')) return { status: 'gone' };
    if (path.includes('/fail')) return { status: 'failed', code: 'HTTP_503' };
    this.recorded.push({
      endpointHash: createHash('sha256').update(target.endpoint).digest('hex').slice(0, 16),
      payload,
      options,
      at: new Date().toISOString(),
    });
    if (this.recorded.length > MAX_RECORDED) this.recorded.shift();
    return { status: 'sent' };
  }

  /** Notifications envoyées (plus récentes en dernier). */
  sent(): readonly RecordedPush[] {
    return [...this.recorded];
  }

  clear(): void {
    this.recorded.length = 0;
  }
}
