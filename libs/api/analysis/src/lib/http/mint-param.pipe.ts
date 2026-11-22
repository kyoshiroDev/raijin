import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { ApiException } from '@raijin/api-core';
import { ANALYSIS_ERROR_MESSAGES, mintAddressSchema } from '@raijin/shared-contracts';

/** Paramètre `:mint` : adresse base58 valide, sinon 400 `MINT_INVALID`. */
@Injectable()
export class MintParamPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = mintAddressSchema.safeParse(value);
    if (!parsed.success) throw new ApiException('MINT_INVALID', HttpStatus.BAD_REQUEST, ANALYSIS_ERROR_MESSAGES.MINT_INVALID);
    return parsed.data;
  }
}

/** Variante tolérante (page publique, image OG) : `null` si l'adresse est invalide. */
export function parseMint(value: unknown): string | null {
  const parsed = mintAddressSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
