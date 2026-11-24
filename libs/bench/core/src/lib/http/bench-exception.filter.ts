import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { BenchError, BenchErrorCode } from '@raijin/bench-contracts';
import type { Response } from 'express';
import { errorCodeOf, safeErrorMessage } from '../security/redact';
import { BENCH_ERROR_MESSAGES, BenchException } from './bench-exception';

const STATUS_CODES: Partial<Record<number, BenchErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'AUTH_SESSION_EXPIRED',
  [HttpStatus.FORBIDDEN]: 'UNAUTHORIZED',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'VALIDATION_ERROR',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'VALIDATION_ERROR',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

/**
 * Format d'erreur unique `{ code, message }` (sans stack). Les erreurs inattendues sont journalisées
 * nettoyées (aucune URL de connexion, clé ni jeton) et rendues `INTERNAL_ERROR`.
 */
@Catch()
export class BenchExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('BenchHttp');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: BenchError = { code: 'INTERNAL_ERROR', message: BENCH_ERROR_MESSAGES.INTERNAL_ERROR };
    if (exception instanceof BenchException) {
      status = exception.getStatus();
      body = exception.getResponse() as BenchError;
    } else if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      body = { code: 'RATE_LIMITED', message: BENCH_ERROR_MESSAGES.RATE_LIMITED };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code = STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR');
      body = { code, message: BENCH_ERROR_MESSAGES[code] };
    } else {
      this.logger.error(`Erreur inattendue (${errorCodeOf(exception)}) : ${safeErrorMessage(exception, 300)}`);
    }
    response.status(status).set('Cache-Control', 'no-store').json(body);
  }
}
