import { createHash } from 'node:crypto';
import {
  SEO_OPPORTUNITY_POSITION,
  adminSeoDataSchema,
  adminTrafficDataSchema,
  type AdminSeoData,
  type AdminTrafficData,
  type DateRange,
  type SeoRow,
} from '@raijin/shared-contracts';

/**
 * Données Google **simulées et déterministes** (`ANALYTICS_PROVIDER=fake`, dev et tests e2e ; refusé en production).
 * Les valeurs dépendent seulement des dates demandées (hachage du jour) : deux appels identiques donnent le même
 * résultat, d'une machine à l'autre. Quelques textes sont volontairement hostiles (balises, très longs) pour vérifier
 * l'échappement de bout en bout. Aucune donnée réelle.
 */

const DAY_MS = 86_400_000;

/** Nombre pseudo-aléatoire stable dans [0, 1) pour une graine texte. */
export function seeded(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) / 2 ** 32;
}

function days(range: DateRange): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`) && out.length < 400; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Visiteurs simulés d'un jour : ~120 à 260, plus le week-end, croissance lente. */
export function fakeDailyUsers(day: string): number {
  const date = new Date(`${day}T00:00:00Z`);
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 1.25 : 1;
  const trend = 1 + ((date.getTime() / DAY_MS) % 365) / 900;
  return Math.round((120 + seeded(`users:${day}`) * 140) * weekend * trend);
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function totals(range: DateRange) {
  const users = days(range).map(fakeDailyUsers);
  const activeUsers = sum(users);
  return {
    activeUsers,
    newUsers: Math.round(activeUsers * 0.72),
    sessions: Math.round(activeUsers * 1.31),
    engagementRate: 0.58 + seeded(`eng:${range.from}:${range.to}`) * 0.08,
    averageEngagementSeconds: 74 + Math.round(seeded(`dur:${range.from}`) * 30),
    mobileShare: 0.68,
  };
}

export const FAKE_PAGES: readonly { path: string; title: string | null; weight: number }[] = [
  { path: '/', title: 'Raijin : vérifie un token Solana avant d’acheter', weight: 0.34 },
  { path: '/tarifs', title: 'Tarifs Raijin', weight: 0.12 },
  { path: '/guides/reconnaitre-un-rug-pull', title: 'Reconnaître un rug pull sur Solana', weight: 0.11 },
  { path: '/guides/mint-authority', title: 'Mint authority : pourquoi c’est important', weight: 0.08 },
  { path: '/faq', title: 'Questions fréquentes', weight: 0.06 },
  { path: '/guides/liquidite-verrouillee', title: null, weight: 0.04 },
  // Titre hostile : doit s'afficher en texte, jamais interprété.
  { path: '/?q=<script>alert(1)</script>', title: '<img src=x onerror=alert(1)>', weight: 0.01 },
];

export const FAKE_SOURCES: readonly { source: string; medium: string; weight: number }[] = [
  { source: 'google', medium: 'organic', weight: 0.46 },
  { source: '(direct)', medium: '(none)', weight: 0.22 },
  { source: 'x.com', medium: 'referral', weight: 0.11 },
  { source: 'newsletter', medium: 'email', weight: 0.07 },
  { source: 'reddit.com', medium: 'referral', weight: 0.05 },
  { source: 'bing', medium: 'organic', weight: 0.03 },
];

const CHANNELS: readonly [string, number][] = [
  ['Organic Search', 0.49],
  ['Direct', 0.22],
  ['Referral', 0.16],
  ['Email', 0.07],
  ['Organic Social', 0.06],
];

const COUNTRIES: readonly [string, string, number][] = [
  ['FR', 'France', 0.52],
  ['BE', 'Belgium', 0.12],
  ['CH', 'Switzerland', 0.09],
  ['CA', 'Canada', 0.08],
  ['US', 'United States', 0.06],
  ['(not set)', '(not set)', 0.01],
];

/** Rapport Trafic simulé, conforme à `adminTrafficDataSchema`. */
export function fakeTraffic(query: { current: DateRange; previous: DateRange }): AdminTrafficData {
  const current = totals(query.current);
  const previous = totals(query.previous);
  const sessions = current.sessions;
  const series = (fn: (day: string) => number) => ({
    points: days(query.current).map((date) => ({ date, value: fn(date) })),
    comparison: days(query.previous).map((date) => ({ date, value: fn(date) })),
  });
  const data: AdminTrafficData = {
    totals: current,
    previousTotals: previous,
    series: [
      { key: 'active_users', unit: 'count', ...series(fakeDailyUsers) },
      { key: 'sessions', unit: 'count', ...series((day) => Math.round(fakeDailyUsers(day) * 1.31)) },
    ],
    topPages: FAKE_PAGES.map((page) => ({
      path: page.path,
      title: page.title,
      views: Math.round(sessions * page.weight * 1.6),
      users: Math.round(current.activeUsers * page.weight),
    })),
    sources: FAKE_SOURCES.map((entry) => ({
      source: entry.source,
      medium: entry.medium,
      sessions: Math.round(sessions * entry.weight),
      keyEvents: Math.round(sessions * entry.weight * 0.04),
    })),
    channels: CHANNELS.map(([channel, weight]) => ({ channel, sessions: Math.round(sessions * weight), share: weight })),
    devices: [
      { category: 'mobile', sessions: Math.round(sessions * 0.68), share: 0.68 },
      { category: 'desktop', sessions: Math.round(sessions * 0.29), share: 0.29 },
      { category: 'tablet', sessions: Math.round(sessions * 0.03), share: 0.03 },
    ],
    countries: COUNTRIES.map(([countryId, country, weight]) => ({ countryId, country, sessions: Math.round(sessions * weight) })),
    events: [
      { name: 'page_view', count: Math.round(sessions * 2.1), isKeyEvent: false },
      { name: 'session_start', count: sessions, isKeyEvent: false },
      { name: 'analyse_demo_lancee', count: Math.round(current.activeUsers * 0.21), isKeyEvent: false },
      { name: 'analyse_demo_resultat', count: Math.round(current.activeUsers * 0.19), isKeyEvent: false },
      { name: 'voir_tarifs', count: Math.round(current.activeUsers * 0.09), isKeyEvent: false },
      { name: 'cta_essai_clic', count: Math.round(current.activeUsers * 0.06), isKeyEvent: true },
      { name: 'inscription_debut', count: Math.round(current.activeUsers * 0.04), isKeyEvent: true },
      { name: 'guide_lu', count: Math.round(current.activeUsers * 0.05), isKeyEvent: false },
      { name: 'faq_ouverte', count: Math.round(current.activeUsers * 0.03), isKeyEvent: false },
    ],
  };
  return adminTrafficDataSchema.parse(data);
}

export const FAKE_QUERIES: readonly string[] = [
  'raijin solana',
  'vérifier token solana',
  'rug pull solana',
  'mint authority solana',
  'freeze authority',
  'token solana arnaque',
  'liquidité verrouillée solana',
  'analyse token solana gratuit',
  'holders concentrés token',
  'rugcheck alternative',
  'solana token scanner',
  'comment savoir si un token est une arnaque',
  '<b>requête hostile</b>',
];

/** Rapport SEO simulé (décalage de 3 jours), conforme à `adminSeoDataSchema`. */
export function fakeSeo(query: { window: '28d' | '90d'; today: string }): AdminSeoData {
  const length = query.window === '28d' ? 28 : 90;
  const through = new Date(Date.parse(`${query.today}T00:00:00Z`) - 3 * DAY_MS).toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${through}T00:00:00Z`) - (length - 1) * DAY_MS).toISOString().slice(0, 10);
  const prevEnd = new Date(Date.parse(`${start}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const prevStart = new Date(Date.parse(`${prevEnd}T00:00:00Z`) - (length - 1) * DAY_MS).toISOString().slice(0, 10);
  const daily = (day: string) => {
    const impressions = Math.round(300 + seeded(`imp:${day}`) * 500);
    const clicks = Math.round(impressions * (0.03 + seeded(`ctr:${day}`) * 0.03));
    return { clicks, impressions, ctr: clicks / impressions, position: 8 + seeded(`pos:${day}`) * 9 };
  };
  const window = (range: DateRange) => {
    const rows = days(range).map(daily);
    const clicks = sum(rows.map((row) => row.clicks));
    const impressions = sum(rows.map((row) => row.impressions));
    return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: sum(rows.map((row) => row.position)) / rows.length };
  };
  const current = window({ from: start, to: through });
  const rows: SeoRow[] = FAKE_QUERIES.map((key, index) => {
    const impressions = Math.round(current.impressions * (0.2 / (index + 1)));
    const position = 1.6 + index * 1.7 + seeded(`qpos:${key}`) * 2;
    const clicks = Math.round(impressions * Math.max(0.005, 0.3 / position));
    return { key, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position };
  });
  const pages: SeoRow[] = FAKE_PAGES.slice(0, 6).map((page, index) => {
    const impressions = Math.round(current.impressions * page.weight);
    const clicks = Math.round(impressions * 0.05);
    return { key: `https://raijinshield.com${page.path}`, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: 3 + index * 2.5 };
  });
  const data: AdminSeoData = {
    window: query.window,
    startDate: start,
    dataThrough: through,
    lagDays: 3,
    totals: current,
    previousTotals: window({ from: prevStart, to: prevEnd }),
    series: days({ from: start, to: through }).map((date) => ({ date, ...daily(date) })),
    topQueries: [...rows].sort((a, b) => b.clicks - a.clicks),
    topPages: pages,
    opportunities: rows
      .filter((row) => row.position !== null && row.position >= SEO_OPPORTUNITY_POSITION.min && row.position <= SEO_OPPORTUNITY_POSITION.max)
      .sort((a, b) => b.impressions - a.impressions),
  };
  return adminSeoDataSchema.parse(data);
}
