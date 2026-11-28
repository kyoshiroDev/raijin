import { Body, Controller, Get, Header, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentAuth, type AuthContext } from '@raijin/api-auth';
import { ApiZodBody } from '@raijin/api-core';
import { walletScanRequestSchema, type WalletScanQuotaResponse, type WalletScanResponse } from '@raijin/shared-contracts';
import { WalletAccessService } from '../access/wallet-access.service';
import { WalletScanService } from '../scan/wallet-scan.service';
import { WalletScanThrottleGuard } from './wallet-scan-throttle.guard';

/**
 * Scan de wallet en lecture seule (`/api/v1/wallet-scans`, docs/ARCHITECTURE.md §12.2). Session
 * obligatoire, CSRF par la garde globale. L'adresse passe **uniquement** dans le corps (jamais dans
 * l'URL : ni historique de navigateur ni journal d'accès qui la contienne). Le corps est validé
 * après le contrôle du plan (ordre session → plan → schéma), d'où l'absence de pipe Zod ici.
 */
@ApiTags('wallet-scans')
@Controller('wallet-scans')
@UseGuards(AuthGuard)
export class WalletScanController {
  constructor(
    private readonly scans: WalletScanService,
    private readonly access: WalletAccessService,
  ) {}

  @Post()
  @HttpCode(200)
  @UseGuards(WalletScanThrottleGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Scanne un wallet (adresse publique, lecture seule) : Pro et essai Pro, quota journalier.' })
  @ApiZodBody(walletScanRequestSchema)
  scan(@Body() body: unknown, @CurrentAuth() auth: AuthContext): Promise<WalletScanResponse> {
    return this.scans.scan(auth.userId, body);
  }

  @Get('quota')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Droit au scan de wallet et quota restant aujourd’hui (UTC).' })
  quota(@CurrentAuth() auth: AuthContext): Promise<WalletScanQuotaResponse> {
    return this.access.quotaResponse(auth.userId);
  }
}
