import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import type * as z from 'zod';
import { BenchException } from './bench-exception';

/** Valide et normalise une entrée avec un schéma de `@raijin/bench-contracts` ; refus : 400 `VALIDATION_ERROR`. */
@Injectable()
export class BenchZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const message = result.error.issues[0]?.message;
    throw new BenchException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST, message && message.length <= 300 ? message : undefined);
  }
}
