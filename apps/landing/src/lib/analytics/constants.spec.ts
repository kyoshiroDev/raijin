import * as contracts from '@raijin/shared-contracts';
import { describe, expect, it } from 'vitest';
import * as local from './constants';

describe('alignement des constantes de la landing sur les contrats', () => {
  it('événements GA4 et emplacements de CTA identiques', () => {
    expect([...local.GA4_EVENT_NAMES]).toEqual([...contracts.GA4_EVENT_NAMES]);
    expect([...local.GA4_CTA_PLACEMENTS]).toEqual([...contracts.GA4_CTA_PLACEMENTS]);
  });

  it('cookies et durées identiques', () => {
    expect(local.CONSENT_COOKIE_NAME).toBe(contracts.CONSENT_COOKIE_NAME);
    expect(local.CONSENT_MAX_AGE_DAYS).toBe(contracts.CONSENT_MAX_AGE_DAYS);
    expect(local.CONSENT_VERSION).toBe(contracts.CONSENT_VERSION);
    expect([...local.CONSENT_PURPOSES]).toEqual([...contracts.CONSENT_PURPOSES]);
    expect(local.ATTRIBUTION_COOKIE_NAME).toBe(contracts.ATTRIBUTION_COOKIE_NAME);
    expect(local.ATTRIBUTION_COOKIE_MAX_AGE_DAYS).toBe(contracts.ATTRIBUTION_COOKIE_MAX_AGE_DAYS);
  });

  it("paramètres d'attribution identiques", () => {
    expect(local.ATTRIBUTION_QUERY_PARAMS).toEqual(contracts.ATTRIBUTION_QUERY_PARAMS);
  });

  it('les valeurs captées respectent signupAttributionSchema', async () => {
    const { captureFromLocation } = await import('./attribution');
    const value = captureFromLocation(
      {
        href: 'https://raijinshield.com/guides/rug-pull?utm_source=x&utm_medium=social&utm_campaign=lancement',
        origin: 'https://raijinshield.com',
      },
      'https://t.co/abc?secret=1',
    );
    expect(contracts.signupAttributionSchema.safeParse(value).success).toBe(true);
    expect(value?.referrer).toBe('https://t.co/abc');
  });
});
