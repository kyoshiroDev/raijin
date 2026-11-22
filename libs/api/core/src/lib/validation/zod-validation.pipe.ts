import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiException } from '../errors/api-exception';

/**
 * Valide (et normalise) une entrée avec un schéma Zod de `@raijin/shared-contracts`.
 * Refus : 400 `VALIDATION_ERROR` avec le premier message du schéma (en français).
 * Usage : `@Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest`.
 */
@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const message = result.error.issues[0]?.message ?? 'Certaines informations sont invalides.';
    throw new ApiException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST, message);
  }
}

/** Schéma OpenAPI (dev) dérivé d'un schéma Zod. */
export function zodToOpenApi(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

/** Documente le corps d'une route avec son schéma Zod (Swagger, dev uniquement). */
export function ApiZodBody(schema: z.ZodType): MethodDecorator {
  return ApiBody({ schema: zodToOpenApi(schema) });
}
