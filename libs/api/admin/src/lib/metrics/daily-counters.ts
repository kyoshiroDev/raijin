import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Mailer } from '@raijin/api-notifications';
import type { Response } from 'express';
import { Observable, tap } from 'rxjs';
import { AdminStore } from '../common/admin-store';
import { utcDay } from '../common/range';

/** Compteurs techniques journaliers (jour UTC) lus par la santé et les agrégats nocturnes. Aucune donnée personnelle. */
export const DAILY_COUNTER_FIELDS = ['api_requests', 'api_errors_5xx', 'emails_sent', 'emails_failed'] as const;
export type DailyCounterField = (typeof DAILY_COUNTER_FIELDS)[number];
export type DailyCounterValues = Readonly<Record<DailyCounterField, number>>;

/** TTL 8 jours : agrégation J-1 et recalcul J-2 / J-3, avec marge. */
export const DAILY_COUNTER_TTL_S = 8 * 86_400;

export function dailyCounterKey(day: string): string {
  return `admin:counters:${day}`;
}

function toCount(value: string | undefined): number {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : 0;
}

/**
 * Compteurs Redis `admin:counters:<jour>` (requêtes et 5xx de l'API, e-mails envoyés et en échec). L'écriture n'est
 * jamais attendue par la requête et ne la fait jamais échouer.
 */
@Injectable()
export class DailyCounters {
  constructor(private readonly store: AdminStore) {}

  /** Horloge (remplacée dans les tests). */
  now(): Date {
    return new Date();
  }

  record(field: DailyCounterField, by = 1): void {
    void this.store.increment(dailyCounterKey(utcDay(this.now())), { [field]: by }, DAILY_COUNTER_TTL_S).catch(() => undefined);
  }

  /** Compteurs d'un jour ; `null` si le stockage ne répond pas. */
  async read(day: string): Promise<DailyCounterValues | null> {
    try {
      const [hash] = await this.store.readHashes([dailyCounterKey(day)]);
      return Object.fromEntries(DAILY_COUNTER_FIELDS.map((field) => [field, toCount(hash?.[field])])) as Record<DailyCounterField, number>;
    } catch {
      return null;
    }
  }
}

/**
 * Intercepteur global (enregistré par `ApiAdminModule`) : une requête comptée par réponse, et une erreur 5xx quand
 * le statut final est ≥ 500. Ni chemin, ni IP, ni identifiant ne sont conservés.
 */
@Injectable()
export class RequestMetricsInterceptor implements NestInterceptor {
  constructor(private readonly counters: DailyCounters) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const response = context.switchToHttp().getResponse<Response>();
    this.counters.record('api_requests');
    // Le statut final (filtre d'exception compris) n'est connu qu'à la fin de la réponse.
    response.once?.('finish', () => {
      if (response.statusCode >= 500) this.counters.record('api_errors_5xx');
    });
    return next.handle().pipe(tap({ error: () => undefined }));
  }
}

const COUNTED = Symbol('raijin:mail-counted');

/**
 * Décore l'instance partagée du `Mailer` (`api-notifications`) pour compter les e-mails envoyés et en échec, sans
 * modifier les services d'envoi. Idempotent (un seul habillage par instance) ; l'erreur d'envoi est relancée telle quelle.
 */
export function countMailer(mailer: Mailer, counters: DailyCounters): void {
  const target = mailer as Mailer & { [COUNTED]?: true };
  if (target[COUNTED]) return;
  const send = mailer.send.bind(mailer);
  target.send = async (message) => {
    try {
      await send(message);
      counters.record('emails_sent');
    } catch (error) {
      counters.record('emails_failed');
      throw error;
    }
  };
  target[COUNTED] = true;
}
