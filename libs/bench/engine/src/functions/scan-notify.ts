// Web Push alerts sent after each scan (service_role client).
// Rules: docs/ARCHITECTURE.md §Notifications push. Pure logic lives in ../_shared/alerts.ts, presets.ts and
// preset-alerts.ts. chore/slim-down: ONE alert preset, « Jeune calme » (evaluateYoungCalmAlert): predicate (« Structure
// cassée » excluded since feat/calm-sl-test), persistence over 2 scans, ONE alert per token while the « Calme » position
// of the previous alert is pending / open (calm_sl30 / calm_sl40 of the same user), a 12 h guard after an alert that
// opened no position, fixed exit plan ×2 / ×0.7, candidates by 1 h volume. alert_settings.alert_preset is always
// 'young_calm'. Quiet hours; caps max_per_hour (4) AND max_per_day (30) distinct notifications (single + grouped).
// Every new alert_log row carries preset 'young_calm'. Alerts open NO paper position: the test books are fed at every
// scan by autoPaperCalmFrenzy (which runs AFTER the alerts), independently of alerts. 'young_frenzy' never alerts.
// Follow-ups of tracked alerts: sendFollowUps.
import type { SupabaseClient } from '../db/bench-db';
import {
  type AlertSettings,
  buildFollowUpPayload,
  buildGroupedPayload,
  buildPayload,
  DEDUP_WINDOW_MS,
  isQuietHour,
  mapLimit,
  PERSISTENCE_MAX_AGE_MS,
  planNotifications,
  type PreviousSnapshot,
  previousSnapshotsFromRows,
  type PushPayload,
} from '../ported/alerts';
import { matchesYoungCalm, type PresetToken } from '../ported/presets';
import {
  ALERT_GUARD_BOOKS,
  ALERT_GUARD_LIMIT,
  DAY_WINDOW_MS,
  parseCalmPositions,
  selectYoungCalmCandidates,
  sentCounts,
  userAlertBudget,
  type YoungCalmCandidate,
} from '../ported/preset-alerts';
import { alertLogRow, MAX_FOLLOWUPS_PER_USER, type OpenPosition } from '../ported/alert-tracking';
import { isAllowedPushEndpoint } from '../ported/push-endpoint';
import { scanRuntime, type ScanPushPort } from './scan-runtime';
import { CALM_FRENZY_BOOKS, CALM_FRENZY_STOP_COOLDOWN_MS, calmFrenzyOpenings } from '../ported/paper-engine';
import {
  autoPaperUserIds,
  CALM_FRENZY_BUDGET_MS,
  CALM_FRENZY_CONCURRENCY,
  CALM_FRENZY_EXISTING_LIMIT,
  CALM_FRENZY_MAX_USERS,
  calmFrenzyMatches,
  calmFrenzyRpcArgs,
  existingReadComplete,
} from '../ported/calm-frenzy-wiring';
import { engineLog } from './log';

const MAX_USERS = 25;
const MAX_SUBS_PER_USER = 5;
const MAX_PUSHES_PER_SCAN = 150;
const CONCURRENCY = 6;
const TIME_BUDGET_MS = 20_000;
const PUSH_TIMEOUT_MS = 8_000;

interface SettingsRow extends AlertSettings {
  user_id: string;
}

const SETTINGS_COLUMNS = 'user_id, quiet_start, quiet_end, max_per_hour, max_per_day, stake_sol';
/** Previous-scan snapshots read per scan (≤ ~3 per mint in 5 min). */
const MAX_PREVIOUS_ROWS = 1000;
const FOLLOWUP_TIME_BUDGET_MS = 8_000;
/** alert_log.preset of every new alert. */
const LOG_PRESET = 'young_calm';

/** Scan-wide push limits (ScanBudget pushStopMs / pushAbortMs): no new push after stopAt, none in flight after abortAt. */
export interface PushDeadline {
  stopAt: number;
  abortAt: number;
}

/** Per-push timeout: ≤ PUSH_TIMEOUT_MS and ending by deadline.abortAt (at least 1 s). */
function pushTimeout(deadline: PushDeadline | undefined): number {
  if (!deadline) return PUSH_TIMEOUT_MS;
  return Math.max(1_000, Math.min(PUSH_TIMEOUT_MS, deadline.abortAt - Date.now()));
}

/** numeric columns may arrive as strings; anything unusable becomes null (the helpers then use the defaults). */
function withNumericThresholds(s: SettingsRow): SettingsRow {
  const n = (v: unknown): number | null => {
    const x = typeof v === 'string' ? Number(v) : v;
    return typeof x === 'number' && Number.isFinite(x) ? x : null;
  };
  return { ...s, max_per_day: n(s.max_per_day), stake_sol: n(s.stake_sol) };
}
interface SubRow {
  id: number;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}
interface LogRow {
  user_id: string;
  mint: string;
  notification_id: string;
  sent_at: string;
}
interface Notification {
  userId: string;
  id: string;
  kind: 'single' | 'grouped';
  mints: string[];
  /** single only: the candidate (exit plan) logged as a tracked position. */
  candidate: YoungCalmCandidate<PresetToken> | null;
  settings: SettingsRow;
  payload: string;
  delivered: boolean;
}

export interface NotifyStats {
  users: number;
  notifications: number;
  removed: number;
}

/**
 * Previous scan state of these mints: latest token_snapshots row (source 'scan') captured in the 5 min before
 * `scanStartedAt` (so this scan's own snapshots never count). Fails CLOSED: on error → empty map → nobody is
 * alertable this scan (persistence cannot be proven).
 */
async function loadPreviousSnapshots(
  db: SupabaseClient,
  mints: string[],
  scanStartedAt: number,
): Promise<Map<string, PreviousSnapshot>> {
  if (mints.length === 0) return new Map();
  const { data, error } = await db
    .from('token_snapshots')
    .select('mint, captured_at')
    .in('mint', mints.slice(0, 200))
    .eq('source', 'scan')
    .gte('captured_at', new Date(scanStartedAt - PERSISTENCE_MAX_AGE_MS).toISOString())
    .lt('captured_at', new Date(scanStartedAt).toISOString())
    .order('captured_at', { ascending: false })
    .limit(MAX_PREVIOUS_ROWS);
  if (error) {
    engineLog.warn('push: previous snapshots unavailable, no alert this scan');
    return new Map();
  }
  return previousSnapshotsFromRows(data, scanStartedAt);
}

/** One push to send for a user. */
interface PushItem {
  kind: 'single' | 'grouped';
  mints: string[];
  candidate: YoungCalmCandidate<PresetToken> | null;
  payload: PushPayload;
}

/**
 * Sends the alerts of this scan. Never throws for "expected" problems; the caller still wraps it in try/catch.
 * `scanStartedAt`: start of the scan (before its snapshots were inserted), for the persistence rule.
 */
export async function notifyUsers(
  db: SupabaseClient,
  tokens: readonly PresetToken[],
  scanStartedAt: number,
  now = Date.now(),
  deadline?: PushDeadline,
): Promise<NotifyStats> {
  const stats: NotifyStats = { users: 0, notifications: 0, removed: 0 };
  // Port Node : push du banc (`@raijin/server-push` via BenchNotifier) ; null = non configuré ou mode ombre.
  const vapid: ScanPushPort | null = scanRuntime().push;
  if (!vapid) return stats; // not configured: skip silently

  // Cheap global prefilter: only the « Jeune calme » matches of this scan can be notified (the guard, the persistence
  // and the caps are per user below); no match → no query at all.
  const pool = tokens.filter((t) => t.mint_authority_disabled === true && t.freeze_authority_disabled === true && matchesYoungCalm(t, now).ok);
  if (pool.length === 0) return stats;
  const calmMints = pool.map((t) => t.mint).slice(0, 200);

  const settingsRes = await db.from('alert_settings').select(SETTINGS_COLUMNS).eq('enabled', true).order('user_id').limit(MAX_USERS);
  if (settingsRes.error) throw new Error(`alert_settings: ${settingsRes.error.message}`);
  const users = ((settingsRes.data ?? []) as unknown as SettingsRow[])
    .map(withNumericThresholds)
    .filter((s) => !isQuietHour(now, s.quiet_start, s.quiet_end));
  if (users.length === 0) return stats;
  const userIds = users.map((u) => u.user_id);

  // 24 h of history: the daily cap needs it; the 12 h guard ignores older rows by itself.
  const since = new Date(now - Math.max(DAY_WINDOW_MS, DEDUP_WINDOW_MS)).toISOString();
  const [subsRes, logResults, previous, guardPositions, guardAlerts] = await Promise.all([
    db
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth')
      .in('user_id', userIds)
      .order('created_at', { ascending: false })
      .limit(MAX_USERS * 10),
    // One query per user (newest first) so the API row cap (1000) can never hide another user's history. With the caps
    // (≤ 4/h, ≤ 30/day) 1000 rows cover 24 h unless grouped pushes log very many mints; then the oldest rows are cut,
    // which can only under-count the DAILY total (the last hour is the newest rows; the alert guard reads its own history).
    mapLimit(userIds, 5, async (id) =>
      await db
        .from('alert_log')
        .select('user_id, mint, notification_id, sent_at')
        .eq('user_id', id)
        .in('kind', ['single', 'grouped'])
        .gte('sent_at', since)
        .order('sent_at', { ascending: false })
        .limit(1000)
    ),
    loadPreviousSnapshots(db, pool.map((t) => t.mint), scanStartedAt),
    // Alert guard: every « Calme » position of these users on the matched mints (any age: a position may stay open for
    // days), and their last alert on those mints whatever its age (the 24 h read above may not reach it).
    db
      .from('paper_positions')
      .select('user_id, book, mint, status, created_at')
      .in('user_id', userIds)
      .in('book', [...ALERT_GUARD_BOOKS])
      .in('mint', calmMints)
      .order('created_at', { ascending: false })
      .limit(ALERT_GUARD_LIMIT),
    db
      .from('alert_log')
      .select('user_id, mint, sent_at')
      .in('user_id', userIds)
      .in('mint', calmMints)
      .in('kind', ['single', 'grouped'])
      .order('sent_at', { ascending: false })
      .limit(1000),
  ]);
  if (subsRes.error) throw new Error(`push_subscriptions: ${subsRes.error.message}`);
  // Fail CLOSED: without a trustworthy position / alert history the guard cannot be proven → no alert this scan.
  const calmPositions = guardPositions.error ? null : parseCalmPositions(guardPositions.data);
  if (calmPositions === null || guardAlerts.error || (guardAlerts.data ?? []).length >= 1000) {
    engineLog.warn('push: alert guard unavailable, no alert this scan', guardPositions.error?.code ?? guardAlerts.error?.code ?? 'full page');
    return stats;
  }
  const logData: LogRow[] = [];
  for (const r of logResults) {
    if (!r || r.error) throw new Error(`alert_log: ${r?.error?.message ?? 'skipped'}`);
    logData.push(...((r.data ?? []) as LogRow[]));
  }

  const subsByUser = new Map<string, SubRow[]>();
  for (const s of (subsRes.data ?? []) as SubRow[]) {
    if (!isAllowedPushEndpoint(s.endpoint)) continue;
    const list = subsByUser.get(s.user_id) ?? [];
    if (list.length < MAX_SUBS_PER_USER) list.push(s);
    subsByUser.set(s.user_id, list);
  }
  const lastByUser = new Map<string, Map<string, number>>();
  const logsByUser = new Map<string, LogRow[]>();
  const noteLast = (userId: string, mint: string, sentAt: string) => {
    const t = Date.parse(sentAt);
    if (!Number.isFinite(t)) return;
    const m = lastByUser.get(userId) ?? new Map<string, number>();
    m.set(mint, Math.max(m.get(mint) ?? -Infinity, t));
    lastByUser.set(userId, m);
  };
  for (const l of logData) {
    noteLast(l.user_id, l.mint, l.sent_at);
    const list = logsByUser.get(l.user_id) ?? [];
    list.push(l);
    logsByUser.set(l.user_id, list);
  }
  for (const l of (guardAlerts.data ?? []) as { user_id: string; mint: string; sent_at: string }[]) {
    if (typeof l.sent_at === 'string' && l.sent_at.length <= 40) noteLast(l.user_id, l.mint, l.sent_at);
  }

  const notifications: Notification[] = [];
  const jobs: { n: Notification; sub: SubRow }[] = [];
  for (const u of users) {
    const subs = subsByUser.get(u.user_id);
    if (!subs || subs.length === 0) continue;
    const candidates = selectYoungCalmCandidates(
      pool,
      lastByUser.get(u.user_id) ?? new Map(),
      now,
      previous,
      calmPositions.get(u.user_id) ?? new Map(),
    );
    const plan = planNotifications(candidates, userAlertBudget(u, sentCounts(logsByUser.get(u.user_id) ?? [], now)));
    const items: PushItem[] = plan.individual.map((t) => ({
      kind: 'single',
      mints: [t.mint],
      candidate: t,
      payload: buildPayload(t, t.plan, t.pair_age_h),
    }));
    if (plan.grouped) {
      items.push({ kind: 'grouped', mints: plan.grouped.mints, candidate: null, payload: buildGroupedPayload(plan.grouped.count) });
    }
    if (items.length === 0) continue;
    stats.users++;
    for (const it of items) {
      const n: Notification = {
        userId: u.user_id,
        id: crypto.randomUUID(),
        kind: it.kind,
        mints: it.mints,
        candidate: it.candidate,
        settings: u,
        payload: JSON.stringify(it.payload),
        delivered: false,
      };
      notifications.push(n);
      for (const sub of subs) jobs.push({ n, sub });
    }
  }
  if (jobs.length === 0) return stats;

  const bounded = jobs.slice(0, MAX_PUSHES_PER_SCAN);
  const results = await mapLimit(
    bounded,
    CONCURRENCY,
    ({ n, sub }) => vapid.send(sub, n.payload, { timeoutMs: pushTimeout(deadline) }),
    Math.min(now + TIME_BUDGET_MS, deadline?.stopAt ?? Infinity),
  );

  const gone = new Set<number>();
  results.forEach((r, i) => {
    if (!r) return;
    if (r.ok) bounded[i]!.n.delivered = true;
    if (r.gone) gone.add(bounded[i]!.sub.id);
  });

  if (gone.size > 0) {
    const { error } = await db.from('push_subscriptions').delete().in('id', [...gone]);
    if (error) engineLog.warn('push: cleanup failed');
    else stats.removed = gone.size;
  }

  // Log only what reached at least one device; undelivered alerts are retried next scan.
  // Single alerts carry their exit plan (tracked position, 7 days); grouped rows keep the plan columns null.
  const delivered = notifications.filter((n) => n.delivered);
  const fullRows = delivered.flatMap((n) =>
    n.kind === 'single' && n.candidate
      ? [{ ...alertLogRow(n.userId, n.id, n.candidate, n.settings, now), preset: LOG_PRESET }]
      : n.mints.map((mint) => ({ user_id: n.userId, mint, notification_id: n.id, kind: n.kind, preset: LOG_PRESET }))
  );
  stats.notifications = delivered.length;
  if (fullRows.length > 0) await writeAlertLog(db, fullRows);
  return stats;
}

export interface CalmFrenzyStats {
  /** Young preset matches of the scan (calm, frenzy), auto_paper users, RPCs sent, positions opened / refused. */
  calm: number;
  frenzy: number;
  users: number;
  attempted: number;
  placed: number;
  skipped: number;
}

/**
 * « Calme » / « Frénésie » auto-paper (feat/calm-sl-test, migration 20261122010000, SIMULATION ONLY): at EVERY scan,
 * for each token matching young_calm / young_frenzy (≤ 10 per preset) and each user with alert_settings.auto_paper =
 * true (≤ 25, whether or not alerts are enabled, quiet hours ignored), opens one all_x2 position (0.1 SOL, entry_mode
 * 'next_tick' = market entry at the next scan snapshot) per book of the preset: calm_sl30 (stop 30 %) + calm_sl40
 * (stop 40 %) for young_calm, frenzy_sl30 (stop 30 %) for young_frenzy, through paper_open_position_as (service_role,
 * no alert link). Independent of alerts: no caps, no persistence, so the books compare like for like.
 * Skipped up-front (calmFrenzyOpenings): a position pending / open in that book on that mint, or a stop on that mint in
 * that book < 12 h ago; the RPC re-checks both, plus the caps, the balance and the token.
 * Fails CLOSED: the auto_paper users or the existing positions unreadable (or a full page) → nothing opened this scan.
 * Bounded: ≤ 100 RPCs, 4 in flight, none started after 4 s. Never throws; logs counts and error codes only.
 */
export async function autoPaperCalmFrenzy(
  db: SupabaseClient,
  tokens: readonly PresetToken[],
  now = Date.now(),
): Promise<CalmFrenzyStats> {
  const stats: CalmFrenzyStats = { calm: 0, frenzy: 0, users: 0, attempted: 0, placed: 0, skipped: 0 };
  // Port Node : jamais d'ouverture automatique en mode ombre (BenchModeService.autoPaperAllowed()).
  if (!scanRuntime().autoPaperAllowed()) return stats;
  try {
    const matches = calmFrenzyMatches(tokens, now);
    stats.calm = matches.filter((m) => m.preset === 'young_calm').length;
    stats.frenzy = matches.length - stats.calm;
    if (matches.length === 0) return stats;
    const usersRes = await db
      .from('alert_settings')
      .select('user_id')
      .eq('auto_paper', true)
      .order('user_id')
      .limit(CALM_FRENZY_MAX_USERS);
    if (usersRes.error) {
      engineLog.warn('calm/frenzy: users unavailable', usersRes.error.code ?? '');
      return stats;
    }
    const userIds = autoPaperUserIds(usersRes.data);
    stats.users = userIds.length;
    if (userIds.length === 0) return stats;
    // Positions of these users on the matched mints in the test books that can still block an opening: pending / open
    // ones, and the ones closed in the last 12 h (per-book stop cooldown).
    const cooldownSince = new Date(now - CALM_FRENZY_STOP_COOLDOWN_MS).toISOString();
    const existingRes = await db
      .from('paper_positions')
      .select('user_id, book, mint, status, paper_legs(status, closed_at)')
      .in('user_id', userIds)
      .in('book', [...CALM_FRENZY_BOOKS])
      .in('mint', matches.map((m) => m.token.mint))
      .or(`status.in.(pending,open),closed_at.gt."${cooldownSince}"`)
      .limit(CALM_FRENZY_EXISTING_LIMIT);
    if (existingRes.error || !existingReadComplete(existingRes.data)) {
      engineLog.warn('calm/frenzy: existing positions unavailable, nothing opened', existingRes.error?.code ?? 'full page');
      return stats;
    }
    const jobs = calmFrenzyRpcArgs(calmFrenzyOpenings(matches, userIds, existingRes.data, now));
    stats.attempted = jobs.length;
    if (jobs.length === 0) return stats;
    const results = await mapLimit(jobs, CALM_FRENZY_CONCURRENCY, async (args) => {
      try {
        const { error } = await db.rpc('paper_open_position_as', args);
        return !error;
      } catch {
        return false;
      }
    }, Date.now() + CALM_FRENZY_BUDGET_MS);
    stats.placed = results.filter((r) => r === true).length;
    stats.skipped = jobs.length - stats.placed;
  } catch (e) {
    engineLog.warn('calm/frenzy skipped', (e instanceof Error ? e.message : String(e)).slice(0, 120));
  }
  return stats;
}

/**
 * Writes the alert_log rows. They drive the alert guard and the hourly / daily caps, so losing them means re-sending the same
 * alerts every scan: never give up silently. Any error → one full retry, then row by row; a single row that still
 * fails is degraded to a plan-less 'grouped' row for the same mint/notification (allowed by alert_log_single_has_plan)
 * so the dedup keeps working. Logs only error codes.
 */
async function writeAlertLog(db: SupabaseClient, fullRows: readonly object[]): Promise<void> {
  const first = await db.from('alert_log').insert([...fullRows]);
  if (!first.error) return;
  engineLog.warn('push: alert_log insert failed, retrying', first.error.code ?? '');
  const retry = await db.from('alert_log').insert([...fullRows]);
  if (!retry.error) return;
  for (const row of fullRows) {
    const { error } = await db.from('alert_log').insert(row);
    if (!error) continue;
    const r = row as { user_id?: unknown; mint?: unknown; notification_id?: unknown; preset?: unknown };
    const degraded = {
      user_id: r.user_id,
      mint: r.mint,
      notification_id: r.notification_id,
      kind: 'grouped',
      ...(typeof r.preset === 'string' ? { preset: r.preset } : {}),
    };
    const { error: degErr } = await db.from('alert_log').insert(degraded);
    if (degErr) engineLog.warn('push: alert_log row lost', degErr.code ?? '');
  }
}

export interface FollowUp {
  position: OpenPosition;
  symbol: string;
}

export interface FollowUpStats {
  due: number;
  sent: number;
  removed: number;
}

/**
 * Follow-up pushes of tracked alerts whose first hit is known (followUpEligible, computed by the caller):
 * « ✅ Objectif atteint » / « 🛑 Invalidation touchée ». Only users with alerts enabled and outside their quiet hours
 * (deferred otherwise, within the 48 h window); NOT counted in the hourly budget; ≤ 5 per user per scan;
 * followup_sent_at is set only when at least one device received it. Never throws for expected problems.
 */
export async function sendFollowUps(
  db: SupabaseClient,
  due: readonly FollowUp[],
  now = Date.now(),
  deadline?: PushDeadline,
): Promise<FollowUpStats> {
  const stats: FollowUpStats = { due: due.length, sent: 0, removed: 0 };
  if (due.length === 0) return stats;
  const vapid: ScanPushPort | null = scanRuntime().push;
  if (!vapid) return stats;

  const userIds = [...new Set(due.map((f) => f.position.userId))].slice(0, MAX_USERS);
  const [settingsRes, subsRes] = await Promise.all([
    db.from('alert_settings').select('user_id, quiet_start, quiet_end').eq('enabled', true).in('user_id', userIds),
    db
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth')
      .in('user_id', userIds)
      .order('created_at', { ascending: false })
      .limit(MAX_USERS * 10),
  ]);
  if (settingsRes.error) throw new Error(`alert_settings: ${settingsRes.error.message}`);
  if (subsRes.error) throw new Error(`push_subscriptions: ${subsRes.error.message}`);
  const awake = new Set(
    ((settingsRes.data ?? []) as { user_id: string; quiet_start: number; quiet_end: number }[])
      .filter((s) => !isQuietHour(now, s.quiet_start, s.quiet_end))
      .map((s) => s.user_id),
  );
  const subsByUser = new Map<string, SubRow[]>();
  for (const s of (subsRes.data ?? []) as SubRow[]) {
    if (!isAllowedPushEndpoint(s.endpoint)) continue;
    const list = subsByUser.get(s.user_id) ?? [];
    if (list.length < MAX_SUBS_PER_USER) list.push(s);
    subsByUser.set(s.user_id, list);
  }

  const perUser = new Map<string, number>();
  const items: { f: FollowUp; payload: string; delivered: boolean }[] = [];
  const jobs: { item: (typeof items)[number]; sub: SubRow }[] = [];
  for (const f of due) {
    const p = f.position;
    const subs = subsByUser.get(p.userId);
    if (!awake.has(p.userId) || !subs || subs.length === 0 || p.firstHit === null) continue;
    const n = perUser.get(p.userId) ?? 0;
    if (n >= MAX_FOLLOWUPS_PER_USER) continue;
    perUser.set(p.userId, n + 1);
    const level = p.firstHit === 'target' ? p.target : p.stop;
    const item = { f, payload: JSON.stringify(buildFollowUpPayload(p.mint, f.symbol, p.firstHit, p.entry, level)), delivered: false };
    items.push(item);
    for (const sub of subs) jobs.push({ item, sub });
  }
  if (jobs.length === 0) return stats;

  // Claim the follow-ups BEFORE sending (atomic: only rows still unclaimed are returned), so an overlapping scan or a
  // failed write afterwards can never send the same follow-up twice. Undelivered claims are released below.
  const candidateIds = [...new Set(items.map((i) => i.f.position.id))];
  const { data: claimed, error: claimErr } = await db
    .from('alert_log')
    .update({ followup_sent_at: new Date(now).toISOString() })
    .in('id', candidateIds)
    .is('followup_sent_at', null)
    .select('id');
  if (claimErr) {
    engineLog.warn('push: followup claim failed', claimErr.code ?? '');
    return stats;
  }
  const claimedIds = new Set(((claimed ?? []) as { id: number }[]).map((r) => r.id));
  const bounded = jobs.filter((j) => claimedIds.has(j.item.f.position.id)).slice(0, MAX_PUSHES_PER_SCAN);
  const results = await mapLimit(
    bounded,
    CONCURRENCY,
    ({ item, sub }) => vapid.send(sub, item.payload, { timeoutMs: pushTimeout(deadline) }),
    Math.min(now + FOLLOWUP_TIME_BUDGET_MS, deadline?.stopAt ?? Infinity),
  );
  const gone = new Set<number>();
  results.forEach((r, i) => {
    if (!r) return;
    if (r.ok) bounded[i]!.item.delivered = true;
    if (r.gone) gone.add(bounded[i]!.sub.id);
  });
  if (gone.size > 0) {
    const { error } = await db.from('push_subscriptions').delete().in('id', [...gone]);
    if (error) engineLog.warn('push: cleanup failed');
    else stats.removed = gone.size;
  }
  const sentIds = items.filter((i) => i.delivered && claimedIds.has(i.f.position.id)).map((i) => i.f.position.id);
  stats.sent = sentIds.length;
  // Release the claims that reached no device, so they can be retried on a later scan (still within 48 h).
  const sent = new Set(sentIds);
  const release = [...claimedIds].filter((id) => !sent.has(id));
  if (release.length > 0) {
    const { error } = await db.from('alert_log').update({ followup_sent_at: null }).in('id', release);
    if (error) engineLog.warn('push: followup release failed', error.code ?? '');
  }
  return stats;
}
