import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '@raijin/api-core';
import {
  adminAcquisitionQuerySchema,
  adminRangeQuerySchema,
  adminSeoQuerySchema,
  type AdminAcquisition,
  type AdminAcquisitionQuery,
  type AdminHealth,
  type AdminOverview,
  type AdminProduct,
  type AdminRangeQuery,
  type AdminRevenue,
  type AdminSeo,
  type AdminSeoQuery,
  type AdminTraffic,
  type AdminTrials,
} from '@raijin/shared-contracts';
import { AdminClock } from '../common/admin-clock';
import { AdminRoute } from '../common/admin-route';
import { HealthService } from '../health/health.service';
import { BusinessReportsService } from '../reports/business-reports.service';
import { GoogleReportsService } from '../reports/google-reports.service';
import { OverviewService } from '../reports/overview.service';

/**
 * Écrans statistiques de l'espace admin (`/api/v1/admin/*`, PROMPT.md §4.7, écrans 1 à 6, 8 et 9). Lecture seule,
 * aucune donnée personnelle ; chaque route est derrière `@AdminRoute()` (404 pour un compte non admin, 2FA, session
 * admin courte) et répond `Cache-Control: no-store`. L'écran Utilisateurs (7) vit dans `users/` (nestjs-api).
 */
@ApiTags('admin')
@Controller('admin')
@AdminRoute()
export class AdminReportsController {
  constructor(
    private readonly clock: AdminClock,
    private readonly overviewService: OverviewService,
    private readonly google: GoogleReportsService,
    private readonly business: BusinessReportsService,
    private readonly healthService: HealthService,
  ) {}

  @Get('overview')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Vue d’ensemble : KPI avec variation, tendance et entonnoir (période ?period= ou ?from=&to=).' })
  overview(@Query(new ZodValidationPipe(adminRangeQuerySchema)) query: AdminRangeQuery): Promise<AdminOverview> {
    return this.overviewService.overview(query, this.clock.now());
  }

  @Get('traffic')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Trafic de la landing (GA4 Data API, cache 1 h ; « Non connecté » sans compte de service).' })
  traffic(@Query(new ZodValidationPipe(adminRangeQuerySchema)) query: AdminRangeQuery): Promise<AdminTraffic> {
    return this.google.traffic(query, this.clock.now());
  }

  @Get('seo')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'SEO (Search Console, 28 ou 90 jours, décalage de 2 à 3 jours affiché).' })
  seo(@Query(new ZodValidationPipe(adminSeoQuerySchema)) query: AdminSeoQuery): Promise<AdminSeo> {
    return this.google.seo(query, this.clock.now());
  }

  @Get('acquisition')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Inscrits et payants par source UTM, support, campagne, page d’arrivée ou site référent.' })
  acquisition(@Query(new ZodValidationPipe(adminAcquisitionQuerySchema)) query: AdminAcquisitionQuery): Promise<AdminAcquisition> {
    return this.business.acquisition(query, this.clock.now());
  }

  @Get('revenue')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Revenus : MRR, nouveaux abonnés, résiliations, échecs de paiement, mensuel / annuel, revenu par source.' })
  revenue(@Query(new ZodValidationPipe(adminRangeQuerySchema)) query: AdminRangeQuery): Promise<AdminRevenue> {
    return this.business.revenue(query, this.clock.now());
  }

  @Get('trials')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Essais : en cours, fin sous 48 h, conversion par cohorte, refus de l’anti-abus.' })
  trials(): Promise<AdminTrials> {
    return this.business.trialsReport(this.clock.now());
  }

  @Get('product')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Produit : analyses, verdicts, tokens les plus analysés, temps de réponse, indisponibilité par source.' })
  product(@Query(new ZodValidationPipe(adminRangeQuerySchema)) query: AdminRangeQuery): Promise<AdminProduct> {
    return this.business.product(query, this.clock.now());
  }

  @Get('health')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Santé technique : jobs, quotas des API externes, erreurs, e-mails, push, base, services, alertes.' })
  health(): Promise<AdminHealth> {
    return this.healthService.health(this.clock.now());
  }
}
