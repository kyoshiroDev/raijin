import * as z from '../zod';
import {
  ADMIN_TOP_ROWS_MAX,
  TIME_SERIES_MAX_POINTS,
  countSchema,
  externalText,
  ratioSchema,
  resolvedRangeSchema,
  timeSeriesSchema,
} from './common';
import { googleReportSchema } from './google';

// =============================================================================================
// Trafic (écran 2) : API Google Analytics Data (GA4), `properties/{GA4_PROPERTY_ID}:runReport`.
// Route : `GET admin/traffic?period=30d` (`adminRangeQuerySchema`) → `AdminTraffic`.
// =============================================================================================

export const GA4_DEVICE_CATEGORIES = ['mobile', 'desktop', 'tablet', 'other'] as const;
export const ga4DeviceCategorySchema = z.enum(GA4_DEVICE_CATEGORIES);
export type Ga4DeviceCategory = z.infer<typeof ga4DeviceCategorySchema>;

export const GA4_DEVICE_LABELS: Readonly<Record<Ga4DeviceCategory, string>> = {
  mobile: 'Mobile',
  desktop: 'Ordinateur',
  tablet: 'Tablette',
  other: 'Autre',
};

const trafficTotalsSchema = z.object({
  activeUsers: countSchema,
  newUsers: countSchema,
  sessions: countSchema,
  engagementRate: ratioSchema,
  averageEngagementSeconds: z.number().min(0),
  /** Part des sessions sur mobile (0 à 1). */
  mobileShare: ratioSchema,
});
export type TrafficTotals = z.infer<typeof trafficTotalsSchema>;

const rows = <T extends z.ZodType>(row: T) => z.array(row).max(ADMIN_TOP_ROWS_MAX);

export const adminTrafficDataSchema = z.object({
  totals: trafficTotalsSchema,
  previousTotals: trafficTotalsSchema.nullable(),
  /** `activeUsers` et `sessions` par jour. */
  series: z.array(timeSeriesSchema).max(4),
  topPages: rows(z.object({ path: externalText(512), title: externalText(300).nullable(), views: countSchema, users: countSchema })),
  sources: rows(z.object({ source: externalText(200), medium: externalText(200), sessions: countSchema, keyEvents: countSchema })),
  channels: rows(z.object({ channel: externalText(100), sessions: countSchema, share: ratioSchema })),
  devices: z.array(z.object({ category: ga4DeviceCategorySchema, sessions: countSchema, share: ratioSchema })).max(4),
  /** `countryId` ISO 3166-1 alpha-2, ou `(not set)`. */
  countries: rows(z.object({ countryId: z.string().regex(/^([A-Z]{2}|\(not set\))$/), country: externalText(100), sessions: countSchema })),
  /** Événements clés (dont ceux de `GA4_EVENT_NAMES`) ; `isKeyEvent` = marqué comme conversion dans GA4. */
  events: rows(z.object({ name: z.string().regex(/^[a-z0-9_]{1,40}$/), count: countSchema, isKeyEvent: z.boolean() })),
});
export type AdminTrafficData = z.infer<typeof adminTrafficDataSchema>;

export const adminTrafficSchema = googleReportSchema(adminTrafficDataSchema, { range: resolvedRangeSchema });
export type AdminTraffic = z.infer<typeof adminTrafficSchema>;

// =============================================================================================
// SEO (écran 3) : API Search Console, `searchanalytics.query` sur `SEARCH_CONSOLE_SITE_URL`.
// Route : `GET admin/seo?window=28d` (`adminSeoQuerySchema`) → `AdminSeo`. Données décalées de 2 à 3 jours.
// =============================================================================================

export const SEO_WINDOWS = ['28d', '90d'] as const;
export const seoWindowSchema = z.enum(SEO_WINDOWS);
export type SeoWindow = z.infer<typeof seoWindowSchema>;

/** Requêtes « à faire progresser » : position moyenne de 5 à 20 inclus, triées par impressions. */
export const SEO_OPPORTUNITY_POSITION = { min: 5, max: 20 } as const;

export const adminSeoQuerySchema = z.object({ window: seoWindowSchema.default('28d') });
export type AdminSeoQuery = z.infer<typeof adminSeoQuerySchema>;

const seoMetricsShape = {
  clicks: countSchema,
  impressions: countSchema,
  ctr: ratioSchema,
  /** Position moyenne (1 = premier résultat). `null` sans impression. */
  position: z.number().min(1).nullable(),
};

export const seoRowSchema = z.object({ key: externalText(2048), ...seoMetricsShape });
export type SeoRow = z.infer<typeof seoRowSchema>;

export const adminSeoDataSchema = z.object({
  window: seoWindowSchema,
  startDate: z.iso.date(),
  /** Dernier jour disponible chez Search Console (affiché : « données jusqu'au … »). */
  dataThrough: z.iso.date(),
  /** Décalage en jours entre aujourd'hui (UTC) et `dataThrough` (2 à 3 en général). */
  lagDays: z.number().int().min(0).max(14),
  totals: z.object(seoMetricsShape),
  previousTotals: z.object(seoMetricsShape).nullable(),
  series: z
    .array(z.object({ date: z.iso.date(), ...seoMetricsShape }))
    .max(TIME_SERIES_MAX_POINTS),
  topQueries: rows(seoRowSchema),
  topPages: rows(seoRowSchema),
  /** Positions `SEO_OPPORTUNITY_POSITION`, triées par impressions décroissantes. */
  opportunities: rows(seoRowSchema),
});
export type AdminSeoData = z.infer<typeof adminSeoDataSchema>;

export const adminSeoSchema = googleReportSchema(adminSeoDataSchema);
export type AdminSeo = z.infer<typeof adminSeoSchema>;
