import { Injectable } from '@nestjs/common';
import { AnalyticsService } from '@raijin/api-analytics';
import {
  adminSeoSchema,
  adminTrafficSchema,
  type AdminRangeQuery,
  type AdminSeo,
  type AdminSeoQuery,
  type AdminTraffic,
} from '@raijin/shared-contracts';
import { resolveRange, utcDay } from '../common/range';

/**
 * Écrans Google : Trafic (GA4 Data API) et SEO (Search Console), via `api-analytics` (cache 1 h, « Non connecté »
 * sans compte de service, jamais de 5xx). Les textes de Google sont hostiles et bornés par les contrats.
 */
@Injectable()
export class GoogleReportsService {
  constructor(private readonly analytics: AnalyticsService) {}

  async traffic(query: AdminRangeQuery, now: Date): Promise<AdminTraffic> {
    const range = resolveRange(query, now);
    const result = await this.analytics.traffic({ current: range.current, previous: range.previous });
    return adminTrafficSchema.parse({ range, service: result.service, data: result.data });
  }

  async seo(query: AdminSeoQuery, now: Date): Promise<AdminSeo> {
    const result = await this.analytics.seo({ window: query.window, today: utcDay(now) });
    return adminSeoSchema.parse({ service: result.service, data: result.data });
  }
}
