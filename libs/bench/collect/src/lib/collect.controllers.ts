import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  ALERT_LOG_LIMIT_MAX,
  BENCH_ROUTES,
  alertEnabledRequestSchema,
  alertLogQuerySchema,
  alertLogRowSchema,
  alertPreferencesSchema,
  alertSettingsSchema,
  marketRatesSchema,
  mintListQuerySchema,
  pricePointSchema,
  SNAPSHOTS_LIMIT_MAX,
  snapshotQuerySchema,
  tokenBriefSchema,
  tokenListQuerySchema,
  tokenParamsSchema,
  tokenRowSchema,
  userPreferencesSchema,
  type AlertEnabledRequest,
  type AlertLogQuery,
  type AlertPreferences,
  type AlertSettings,
  type BenchTokenRow,
  type MintListQuery,
  type PushTestResponse,
  type TokenListQuery,
  type UserPreferences,
} from '@raijin/bench-contracts';
import { BenchException, BenchModeService, BenchNotifier, BenchRedis, BenchZodPipe } from '@raijin/bench-core';
import { buildTestPayload, isAllowedPushEndpoint } from '@raijin/bench-engine';
import { BenchSqlService } from '@raijin/bench-prisma';
import {
  pushSubscriptionRequestSchema,
  pushUnsubscribeRequestSchema,
  type PushSubscriptionRequest,
  type PushUnsubscribeRequest,
} from '@raijin/shared-contracts';
import type * as z from 'zod';
import { TOKEN_COLUMNS } from './token-columns';

/** Lignes valides d'une liste (une ligne hors contrat est écartée, jamais renvoyée telle quelle). */
export function validRows<T extends z.ZodType>(schema: T, rows: readonly unknown[]): z.output<T>[] {
  const out: z.output<T>[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Erreur de base : 500 générique (le détail SQL n'est jamais renvoyé). */
function fail(): never {
  throw new BenchException('INTERNAL_ERROR', HttpStatus.INTERNAL_SERVER_ERROR);
}

/** `GET /api/tokens`, `/tokens/briefs`, `/tokens/:mint`, `/tokens/:mint/snapshots`, `/market/rates` (ex-lectures supabase-js). */
@Controller()
export class BenchTokensController {
  constructor(private readonly sql: BenchSqlService) {}

  @Get(BENCH_ROUTES.tokens)
  async list(@Query(new BenchZodPipe(tokenListQuerySchema)) query: TokenListQuery) {
    const { data, error } = await this.sql.db
      .from('tokens')
      .select(TOKEN_COLUMNS)
      .gte('updated_at', query.since)
      .order('pair_created_at', { ascending: false, nullsFirst: false })
      .limit(query.limit + 1);
    if (error) fail();
    const rows = (data ?? []) as unknown[];
    return { items: validRows(tokenRowSchema, rows.slice(0, query.limit)), truncated: rows.length > query.limit };
  }

  @Get(BENCH_ROUTES.tokenBriefs)
  async briefs(@Query(new BenchZodPipe(mintListQuerySchema)) query: MintListQuery) {
    const { data, error } = await this.sql.db.from('tokens').select('mint, symbol, price_usd').in('mint', query.mints);
    if (error) fail();
    const byMint = new Map(((data ?? []) as { mint: string; symbol: string | null; price_usd: number | null }[]).map((r) => [r.mint, r]));
    const missing = query.mints.filter((m) => !byMint.has(m));
    for (const mint of missing) {
      const snap = await this.sql.db.from('token_snapshots').select('mint, price_usd').eq('mint', mint).order('captured_at', { ascending: false }).limit(1);
      const row = ((snap.data ?? []) as { mint: string; price_usd: number | null }[])[0];
      if (row) byMint.set(mint, { mint, symbol: null, price_usd: row.price_usd });
    }
    return { items: validRows(tokenBriefSchema, query.mints.map((m) => byMint.get(m)).filter((r) => r !== undefined)), truncated: false };
  }

  @Get(BENCH_ROUTES.token)
  async one(@Param(new BenchZodPipe(tokenParamsSchema)) params: { mint: string }): Promise<BenchTokenRow> {
    const { data, error } = await this.sql.db.from('tokens').select(TOKEN_COLUMNS).eq('mint', params.mint).maybeSingle();
    if (error) fail();
    const parsed = tokenRowSchema.safeParse(data);
    if (!data || !parsed.success) throw new BenchException('NOT_FOUND', HttpStatus.NOT_FOUND);
    return parsed.data;
  }

  @Get(BENCH_ROUTES.tokenSnapshots)
  async snapshots(
    @Param(new BenchZodPipe(tokenParamsSchema)) params: { mint: string },
    @Query(new BenchZodPipe(snapshotQuerySchema)) query: { since: string },
  ) {
    // Pages de 1 000 (plafond PostgREST conservé), du plus ancien au plus récent, au plus SNAPSHOTS_LIMIT_MAX points.
    const rows: unknown[] = [];
    for (let from = 0; from <= SNAPSHOTS_LIMIT_MAX; from += 1000) {
      const { data, error } = await this.sql.db
        .from('token_snapshots')
        .select('price_usd, captured_at')
        .eq('mint', params.mint)
        .gte('captured_at', query.since)
        .order('captured_at', { ascending: true })
        .range(from, from + 999);
      if (error) fail();
      rows.push(...((data ?? []) as unknown[]));
      if ((data ?? []).length < 1000) break;
    }
    const valid = validRows(pricePointSchema, rows);
    return { items: valid.slice(0, SNAPSHOTS_LIMIT_MAX), truncated: valid.length > SNAPSHOTS_LIMIT_MAX };
  }

  @Get(BENCH_ROUTES.marketRates)
  async rates() {
    const { data, error } = await this.sql.db
      .from('scan_runs')
      .select('sol_usd, eur_usd')
      .not('sol_usd', 'is', null)
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) fail();
    const parsed = marketRatesSchema.safeParse(((data ?? []) as unknown[])[0]);
    return { rates: parsed.success ? parsed.data : null };
  }
}

const DEFAULT_SETTINGS: AlertSettings = {
  enabled: false,
  hide_bonding_curve: true,
  quiet_start: 23,
  quiet_end: 7,
  max_per_hour: 4,
  max_per_day: 30,
  stake_sol: 0.05,
  auto_paper: false,
  paper_sl_pct: 30,
};
const SETTINGS_SELECT = Object.keys(alertSettingsSchema.shape).join(',');

/** Journal des alertes et réglages (ligne unique du compte propriétaire, `user_id` = `bench_owner_id()`). */
@Controller()
export class BenchAlertsController {
  constructor(private readonly sql: BenchSqlService) {}

  @Get(BENCH_ROUTES.alerts)
  async list(@Query(new BenchZodPipe(alertLogQuerySchema)) query: AlertLogQuery) {
    let q = this.sql.db
      .from('alert_log')
      .select(Object.keys(alertLogRowSchema.shape).join(','))
      .in('kind', ['single', 'grouped']);
    if (query.mint) q = q.eq('mint', query.mint);
    if (query.since) q = q.gte('sent_at', query.since);
    const { data, error } = await q.order('sent_at', { ascending: false }).limit(Math.min(query.limit, ALERT_LOG_LIMIT_MAX) + 1);
    if (error) fail();
    const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => ({ ...r, id: String(r['id']) }));
    return { items: validRows(alertLogRowSchema, rows.slice(0, query.limit)), truncated: rows.length > query.limit };
  }

  async settings(): Promise<AlertSettings> {
    const { data, error } = await this.sql.db.from('alert_settings').select(SETTINGS_SELECT).limit(1);
    if (error) fail();
    const parsed = alertSettingsSchema.safeParse(((data ?? []) as unknown[])[0]);
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  @Get(BENCH_ROUTES.alertSettings)
  get(): Promise<AlertSettings> {
    return this.settings();
  }

  /** Ligne unique : `upsert` sur `user_id` (défaut `bench_owner_id()`), déclencheur `touch_updated_at` conservé. */
  private async save(values: Partial<AlertSettings>): Promise<AlertSettings> {
    const owner = await this.sql.query<{ id: string | null }>('select public.bench_owner_id() as id');
    const userId = owner.rows[0]?.id;
    if (!userId) throw BenchException.unauthorized();
    const { error } = await this.sql.db.from('alert_settings').upsert({ user_id: userId, ...values }, { onConflict: 'user_id' });
    if (error) throw new BenchException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST);
    return this.settings();
  }

  @Put(BENCH_ROUTES.alertSettings)
  put(@Body(new BenchZodPipe(alertPreferencesSchema)) body: AlertPreferences): Promise<AlertSettings> {
    return this.save(body);
  }

  @Put(BENCH_ROUTES.alertEnabled)
  enabled(@Body(new BenchZodPipe(alertEnabledRequestSchema)) body: AlertEnabledRequest): Promise<AlertSettings> {
    return this.save({ enabled: body.enabled });
  }

  @Get(BENCH_ROUTES.preferences)
  async preferences(): Promise<UserPreferences> {
    return userPreferencesSchema.parse(await this.settings());
  }
}

const MAX_TEST_SUBS = 5;
const TEST_PUSH_TTL_SECONDS = 600;
const TEST_PUSH_WINDOW_S = 60;

/** Push du banc : clé publique, abonnements (≤ 10, déclencheur SQL conservé), test (1 / min, refusé en mode ombre). */
@Controller()
export class BenchPushController {
  private lastTestAt = 0;

  constructor(
    private readonly sql: BenchSqlService,
    private readonly notifier: BenchNotifier,
    private readonly mode: BenchModeService,
    private readonly redis: BenchRedis,
  ) {}

  @Get(BENCH_ROUTES.pushVapidKey)
  vapidKey(): { publicKey: string | null } {
    return { publicKey: this.notifier.pushPublicKey };
  }

  @Post(BENCH_ROUTES.pushSubscriptions)
  @HttpCode(HttpStatus.NO_CONTENT)
  async subscribe(@Body(new BenchZodPipe(pushSubscriptionRequestSchema)) body: PushSubscriptionRequest, @Req() req: { headers: Record<string, unknown> }): Promise<void> {
    if (!isAllowedPushEndpoint(body.endpoint)) throw new BenchException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST);
    const ua = typeof req.headers['user-agent'] === 'string' ? (req.headers['user-agent'] as string).slice(0, 300) : null;
    const { error } = await this.sql.db
      .from('push_subscriptions')
      .upsert({ endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, user_agent: ua }, { onConflict: 'endpoint' });
    if (error) throw new BenchException(error.code === '23514' ? 'CONFLICT' : 'VALIDATION_ERROR', error.code === '23514' ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST);
  }

  @Post(BENCH_ROUTES.pushUnsubscribe)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribe(@Body(new BenchZodPipe(pushUnsubscribeRequestSchema)) body: PushUnsubscribeRequest): Promise<void> {
    const { error } = await this.sql.db.from('push_subscriptions').delete().eq('endpoint', body.endpoint);
    if (error) fail();
  }

  /** Ex-Edge Function `send-test-push` : 1 test par minute (Redis `raijin-bench:push:test`), 409 en mode ombre. */
  @Post(BENCH_ROUTES.pushTest)
  async test(): Promise<PushTestResponse> {
    if (!this.mode.notificationsAllowed()) throw new BenchException('BENCH_SHADOW_MODE', HttpStatus.CONFLICT);
    if (!this.notifier.pushConfigured) throw new BenchException('UPSTREAM_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    if (!(await this.claimTestSlot())) throw new BenchException('RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    const { data, error } = await this.sql.db
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .order('created_at', { ascending: false })
      .limit(MAX_TEST_SUBS);
    if (error) fail();
    const targets = ((data ?? []) as { id: number; endpoint: string; p256dh: string; auth: string }[]).filter((s) => isAllowedPushEndpoint(s.endpoint));
    const payload = buildTestPayload();
    let sent = 0;
    let failed = 0;
    const gone: number[] = [];
    for (const target of targets) {
      const result = await this.notifier.sendBenchPush(target, payload, { ttlSeconds: TEST_PUSH_TTL_SECONDS, urgency: 'normal' });
      if (result.status === 'sent') sent++;
      else {
        failed++;
        if (result.status === 'gone') gone.push(target.id);
      }
    }
    if (gone.length > 0) await this.sql.db.from('push_subscriptions').delete().in('id', gone);
    return { sent, failed };
  }

  private async claimTestSlot(): Promise<boolean> {
    const redis = this.redis.prefixed;
    if (redis) {
      try {
        return (await redis.set('push:test', '1', 'EX', TEST_PUSH_WINDOW_S, 'NX')) === 'OK';
      } catch {
        // Redis indisponible : repli en mémoire (processus unique).
      }
    }
    const now = Date.now();
    if (now - this.lastTestAt < TEST_PUSH_WINDOW_S * 1000) return false;
    this.lastTestAt = now;
    return true;
  }
}
