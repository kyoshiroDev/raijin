// Edge Function: send-test-push
// Called by the signed-in app (Réglages → « Tester »). verify_jwt = true (supabase/config.toml).
// Sends a test notification to the CALLER's own subscriptions only, rate-limited to 1 per minute per user.
// Deploy: supabase functions deploy send-test-push
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, ALLOWED_ORIGINS (comma-separated https origins).
// Provided by the platform: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { buildTestPayload, mapLimit } from '../_shared/alerts.ts';
import { corsHeaders, parseAllowedOrigins } from '../_shared/cors.ts';
import { isAllowedPushEndpoint, loadVapidConfig, sendWebPush } from '../_shared/webpush.ts';

const MAX_SUBS = 5;
const ALLOWED = parseAllowedOrigins(Deno.env.get('ALLOWED_ORIGINS'));

interface SubRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin, ALLOWED);
  // A browser call from an unknown origin is refused outright (CORS is not auth, the JWT is).
  if (origin && !cors) return new Response('Forbidden', { status: 403 });
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...(cors ?? {}), 'Cache-Control': 'no-store', ...extra } });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors ?? {} });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authorization = req.headers.get('authorization') ?? '';
  if (!/^Bearer \S+$/.test(authorization)) return json({ error: 'unauthorized' }, 401);

  const url = Deno.env.get('SUPABASE_URL')!;
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  const userId = userData?.user?.id;
  if (userErr || !userId) return json({ error: 'unauthorized' }, 401);

  const vapid = loadVapidConfig((k) => Deno.env.get(k));
  if (!vapid) return json({ error: 'push_not_configured' }, 503);

  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  // Atomic rate limit (insert-or-update ... where last_sent_at < now() - 1 min).
  const { data: allowed, error: rlErr } = await db.rpc('claim_test_push', { p_user: userId });
  if (rlErr) return json({ error: 'internal' }, 500);
  if (allowed !== true) return json({ error: 'too_many_requests' }, 429, { 'Retry-After': '60' });

  const { data: subs, error: subsErr } = await db
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_SUBS);
  if (subsErr) return json({ error: 'internal' }, 500);

  const targets = ((subs ?? []) as SubRow[]).filter((s) => isAllowedPushEndpoint(s.endpoint));
  const payload = JSON.stringify(buildTestPayload());
  const jwtCache = new Map<string, Promise<string>>();
  const results = await mapLimit(targets, 3, (s) => sendWebPush(s, payload, vapid, { jwtCache, ttl: 600, timeoutMs: 8_000 }));

  const goneIds = targets.filter((_, i) => results[i]?.gone).map((s) => s.id);
  let removed = 0;
  if (goneIds.length > 0) {
    const { error } = await db.from('push_subscriptions').delete().eq('user_id', userId).in('id', goneIds);
    if (!error) removed = goneIds.length;
  }
  const sent = results.filter((r) => r?.ok).length;
  return json({ sent, removed });
});
