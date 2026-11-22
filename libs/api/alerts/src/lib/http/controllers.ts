import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Injectable, Param, Patch, Post, Query, Res, UseGuards, type PipeTransform } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, Client, CurrentAuth, type AuthContext, type ClientInfo } from '@raijin/api-auth';
import { ApiException, ApiZodBody, ZodValidationPipe } from '@raijin/api-core';
import {
  alertListQuerySchema,
  alertReadRequestSchema,
  notificationPreferencesUpdateSchema,
  pushSubscriptionRequestSchema,
  pushUnsubscribeRequestSchema,
  WATCH_ERROR_MESSAGES,
  watchCreateRequestSchema,
  watchIdParamSchema,
  watchKeepRequestSchema,
  watchUpdateRequestSchema,
  type AlertListQuery,
  type AlertListResponse,
  type AlertReadRequest,
  type AlertUnreadCount,
  type NotificationPreferencesUpdate,
  type NotificationSettings,
  type PushSubscriptionRequest,
  type PushSubscriptionResponse,
  type PushUnsubscribeRequest,
  type VapidPublicKeyResponse,
  type Watch,
  type WatchCreateRequest,
  type WatchKeepRequest,
  type WatchListResponse,
  type WatchUpdateRequest,
} from '@raijin/shared-contracts';
import type { Response } from 'express';
import * as z from 'zod';
import { AlertsService } from '../alerts/alerts.service';
import { NotificationSettingsService } from '../notifications/notification-settings.service';
import { PushSubscriptionsService } from '../push/push-subscriptions.service';
import { keepInvalid, WatchesService } from '../watches/watches.service';

/** `:id` d'un suivi : UUID, sinon 404 (jamais d'indice sur l'existence). */
@Injectable()
export class WatchIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = watchIdParamSchema.safeParse({ id: value });
    if (!parsed.success) throw new ApiException('WATCH_NOT_FOUND', HttpStatus.NOT_FOUND, WATCH_ERROR_MESSAGES.WATCH_NOT_FOUND);
    return parsed.data.id;
  }
}

/** Abonnement push refusé par le contrat : 400 `PUSH_SUBSCRIPTION_INVALID` (et non `VALIDATION_ERROR`). */
@Injectable()
export class PushSubscriptionPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const parsed = this.schema.safeParse(value ?? {});
    if (!parsed.success) throw new ApiException('PUSH_SUBSCRIPTION_INVALID', HttpStatus.BAD_REQUEST, WATCH_ERROR_MESSAGES.PUSH_SUBSCRIPTION_INVALID);
    return parsed.data;
  }
}

/** Corps de `POST watches/keep` refusé par le contrat : 400 `WATCH_KEEP_INVALID`. */
@Injectable()
export class WatchKeepPipe implements PipeTransform<unknown, WatchKeepRequest> {
  transform(value: unknown): WatchKeepRequest {
    const parsed = watchKeepRequestSchema.safeParse(value ?? {});
    if (!parsed.success) throw keepInvalid();
    return parsed.data;
  }
}

/** Suivis (`/api/v1/watches`), session + e-mail vérifié, CSRF sur les mutations. */
@ApiTags('suivis')
@Controller('watches')
@UseGuards(AuthGuard)
export class WatchesController {
  constructor(private readonly watches: WatchesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Suivis de l’utilisateur, dernier verdict et limites du plan.' })
  list(@CurrentAuth() auth: AuthContext): Promise<WatchListResponse> {
    return this.watches.list(auth.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Suit un token analysé il y a moins de 24 h (201, 200 si déjà suivi).' })
  @ApiZodBody(watchCreateRequestSchema)
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(watchCreateRequestSchema)) body: WatchCreateRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Watch> {
    const { watch, created } = await this.watches.create(auth.userId, body.mint);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return watch;
  }

  @Post('keep')
  @HttpCode(200)
  @ApiOperation({ summary: 'Choisit les suivis qui restent actifs (fin d’essai) ; les autres passent en pause, jamais supprimés.' })
  @ApiZodBody(watchKeepRequestSchema)
  keep(@CurrentAuth() auth: AuthContext, @Body(WatchKeepPipe) body: WatchKeepRequest): Promise<WatchListResponse> {
    return this.watches.keep(auth.userId, body.watchIds);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Met en pause ou reprend un suivi.' })
  @ApiZodBody(watchUpdateRequestSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', WatchIdPipe) id: string,
    @Body(new ZodValidationPipe(watchUpdateRequestSchema)) body: WatchUpdateRequest,
  ): Promise<Watch> {
    return this.watches.update(auth.userId, id, body.status);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Retire un suivi.' })
  remove(@CurrentAuth() auth: AuthContext, @Param('id', WatchIdPipe) id: string): Promise<void> {
    return this.watches.remove(auth.userId, id);
  }
}

/** Alertes (`/api/v1/alerts`), session. */
@ApiTags('alertes')
@Controller('alerts')
@UseGuards(AuthGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Alertes paginées par curseur (filtres lu/non lu, types, mint).' })
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(alertListQuerySchema)) query: AlertListQuery): Promise<AlertListResponse> {
    return this.alerts.list(auth.userId, query);
  }

  @Get('unread-count')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Nombre d’alertes non lues (badge de navigation).' })
  unread(@CurrentAuth() auth: AuthContext): Promise<AlertUnreadCount> {
    return this.alerts.unreadCount(auth.userId);
  }

  @Post('read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marque des alertes lues ou non lues, ou tout comme lu.' })
  @ApiZodBody(alertReadRequestSchema)
  read(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(alertReadRequestSchema)) body: AlertReadRequest): Promise<AlertUnreadCount> {
    return this.alerts.markRead(auth.userId, body);
  }
}

/** Préférences de notification (`/api/v1/notifications`), session. */
@ApiTags('notifications')
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly settings: NotificationSettingsService) {}

  @Get('settings')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Préférences et état du push (plan, clés, appareils).' })
  get(@CurrentAuth() auth: AuthContext): Promise<NotificationSettings> {
    return this.settings.settings(auth.userId);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Modifie les préférences (push réservé au Pro et à l’essai).' })
  @ApiZodBody(notificationPreferencesUpdateSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(notificationPreferencesUpdateSchema)) body: NotificationPreferencesUpdate,
  ): Promise<NotificationSettings> {
    return this.settings.update(auth.userId, body);
  }
}

/** Push web (`/api/v1/push`). */
@ApiTags('push')
@Controller('push')
export class PushController {
  constructor(private readonly subscriptions: PushSubscriptionsService) {}

  @Get('vapid-public-key')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'Clé publique VAPID (503 PUSH_NOT_SUPPORTED sans clés).' })
  publicKey(): VapidPublicKeyResponse {
    return this.subscriptions.publicKey();
  }

  @Post('subscriptions')
  @HttpCode(201)
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Abonne cet appareil au push (Pro et essai).' })
  @ApiZodBody(pushSubscriptionRequestSchema)
  subscribe(
    @CurrentAuth() auth: AuthContext,
    @Body(new PushSubscriptionPipe(pushSubscriptionRequestSchema)) body: PushSubscriptionRequest,
    @Client() client: ClientInfo,
  ): Promise<PushSubscriptionResponse> {
    return this.subscriptions.subscribe(auth.userId, body, client.userAgent);
  }

  @Post('unsubscribe')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Désabonne un appareil.' })
  @ApiZodBody(pushUnsubscribeRequestSchema)
  unsubscribe(
    @CurrentAuth() auth: AuthContext,
    @Body(new PushSubscriptionPipe(pushUnsubscribeRequestSchema)) body: PushUnsubscribeRequest,
  ): Promise<void> {
    return this.subscriptions.unsubscribe(auth.userId, body.endpoint);
  }
}
