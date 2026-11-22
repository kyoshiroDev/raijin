import { Module } from '@nestjs/common';

/**
 * Scan de wallet en lecture seule (PROMPT.md §4.3, docs/ARCHITECTURE.md §12) : `POST wallet-scans`,
 * `GET wallet-scans/quota`. Rempli par nestjs-api en phase 5 (contrats `wallet/` de
 * `@raijin/shared-contracts`, collecte `collectWallet` de `@raijin/api-solana`).
 */
@Module({
  controllers: [],
  providers: [],
  exports: [],
})
export class ApiWalletModule {}
