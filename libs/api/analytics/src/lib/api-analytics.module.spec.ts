import { ApiAnalyticsModule } from './api-analytics.module';

describe('ApiAnalyticsModule', () => {
  it('est exporté par la lib (test minimal, complété par les clients GA4 et Search Console)', () => {
    expect(typeof ApiAnalyticsModule).toBe('function');
  });
});
