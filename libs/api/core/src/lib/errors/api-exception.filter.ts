import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ApiErrorCode } from '@raijin/shared-contracts';
import type { Response } from 'express';
import { ApiException, defaultMessage } from './api-exception';
import { redactCredentials } from '../security/redact';

const STATUS_CODES: Readonly<Record<number, ApiErrorCode>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_ERROR',
  415: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
};

interface ErrorBody {
  code: ApiErrorCode;
  message: string;
  stack?: string;
}

/**
 * Filtre global : toute erreur devient `{code, message}` (contrat `ApiError`).
 * Les erreurs inattendues sont journalisées côté serveur et rendues en 500 `INTERNAL_ERROR` ;
 * la stack n'est jointe à la réponse qu'en développement. Toute réponse d'erreur porte `Cache-Control: no-store`
 * (audit 6 bis n1) : un 404 de route inconnue est identique au 404 de l'espace admin invisible.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  constructor(private readonly exposeStack: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toBody(exception);
    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? redactCredentials(`${exception.name}: ${exception.message}`) : 'Erreur inconnue',
        exception instanceof Error && exception.stack ? redactCredentials(exception.stack) : undefined,
      );
      if (this.exposeStack && exception instanceof Error && exception.stack) {
        body.stack = redactCredentials(exception.stack);
      }
    }
    if (response.headersSent) return;
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json(body);
  }

  private toBody(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof ApiException) {
      const payload = exception.getResponse() as { message: string };
      return { status: exception.getStatus(), body: { code: exception.code, message: payload.message } };
    }
    if (exception instanceof ThrottlerException) {
      return { status: 429, body: { code: 'RATE_LIMITED', message: defaultMessage('RATE_LIMITED') } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR');
      return { status, body: { code, message: defaultMessage(code) } };
    }
    // Erreurs de body-parser (JSON invalide, corps trop gros) : elles portent un `status` 4xx.
    const status = (exception as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = STATUS_CODES[status] ?? 'VALIDATION_ERROR';
      return { status, body: { code, message: defaultMessage(code) } };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'INTERNAL_ERROR', message: defaultMessage('INTERNAL_ERROR') },
    };
  }
}
