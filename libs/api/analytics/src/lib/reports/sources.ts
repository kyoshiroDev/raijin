import type { AdminSeoData, AdminTrafficData } from '@raijin/shared-contracts';
import { fakeSeo, fakeTraffic } from '../../testing/fixtures/fake-reports';
import type { ReportSources } from '../analytics.service';
import type { AnalyticsConfig } from '../config/analytics-config';
import { Ga4Client } from '../google/ga4-client';
import { GoogleTokenProvider } from '../google/google-auth';
import type { FetchFn } from '../google/google-http';
import { SearchConsoleClient } from '../google/search-console-client';
import type { ReportSource, SeoQuery, TrafficQuery } from './report-source';

/** Données simulées déterministes (`ANALYTICS_PROVIDER=fake`). */
export class FakeReportSource implements ReportSource {
  readonly simulated = true;

  async traffic(query: TrafficQuery): Promise<AdminTrafficData> {
    return fakeTraffic(query);
  }

  async seo(query: SeoQuery): Promise<AdminSeoData> {
    return fakeSeo(query);
  }
}

/** GA4 réel. */
export class Ga4ReportSource implements ReportSource {
  readonly simulated = false;

  constructor(private readonly client: Ga4Client) {}

  traffic(query: TrafficQuery): Promise<AdminTrafficData> {
    return this.client.traffic(query);
  }

  seo(): Promise<AdminSeoData> {
    return Promise.reject(new Error('Search Console non géré par la source GA4'));
  }
}

/** Search Console réelle. */
export class SearchConsoleReportSource implements ReportSource {
  readonly simulated = false;

  constructor(private readonly client: SearchConsoleClient) {}

  traffic(): Promise<AdminTrafficData> {
    return Promise.reject(new Error('GA4 non géré par la source Search Console'));
  }

  seo(query: SeoQuery): Promise<AdminSeoData> {
    return this.client.seo(query);
  }
}

/**
 * Sources selon la configuration : simulées (`fake`), réelles (compte de service + propriété), sinon `null`
 * (« Non connecté »). Un seul jeton OAuth en mémoire, partagé par GA4 et Search Console.
 */
export function createReportSources(config: AnalyticsConfig, fetchFn: FetchFn = (input, init) => fetch(input, init)): ReportSources {
  if (config.provider === 'fake') {
    const fake = new FakeReportSource();
    return { ga4: fake, searchConsole: fake };
  }
  if (config.provider !== 'google' || !config.serviceAccount) return { ga4: null, searchConsole: null };
  const tokens = new GoogleTokenProvider(config.serviceAccount, fetchFn);
  const token = () => tokens.accessToken();
  return {
    ga4: config.ga4PropertyId ? new Ga4ReportSource(new Ga4Client(config.ga4PropertyId, token, fetchFn)) : null,
    searchConsole: config.searchConsoleSiteUrl ? new SearchConsoleReportSource(new SearchConsoleClient(config.searchConsoleSiteUrl, token, fetchFn)) : null,
  };
}
