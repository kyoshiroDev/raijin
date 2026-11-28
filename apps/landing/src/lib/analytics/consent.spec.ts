// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://raijinshield.com/"}
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENT_MAX_AGE_DAYS } from './constants';
import { parseConsent, readConsent, serializeConsent, writeConsent } from './consent';
import { writeCookie } from './cookies';

const DAY = 86_400_000;
const NOW = new Date('2026-11-22T10:00:00Z');

function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

describe('consentement', () => {
  afterEach(clearCookies);

  it('sérialise au format v1.granted|denied.<date>', () => {
    expect(serializeConsent(true, NOW)).toBe('v1.granted.2026-11-22');
    expect(serializeConsent(false, NOW)).toBe('v1.denied.2026-11-22');
  });

  it('relit un choix valide (accepté ou refusé)', () => {
    expect(parseConsent('v1.granted.2026-11-22', NOW)?.analytics).toBe(true);
    expect(parseConsent('v1.denied.2026-11-01', NOW)?.analytics).toBe(false);
  });

  it('expire après 6 mois (182 jours) : la bannière est reproposée', () => {
    const day = new Date('2026-05-24T00:00:00Z');
    expect(parseConsent('v1.granted.2026-05-24', new Date(day.getTime() + (CONSENT_MAX_AGE_DAYS - 1) * DAY))).not.toBeNull();
    expect(parseConsent('v1.granted.2026-05-24', new Date(day.getTime() + CONSENT_MAX_AGE_DAYS * DAY))).toBeNull();
  });

  it('refuse les valeurs illisibles, futures ou d’une autre version', () => {
    for (const value of ['', 'granted', 'v2.granted.2026-11-22', 'v1.maybe.2026-11-22', 'v1.granted.2027-01-01', 'v1.granted.2026-13-45']) {
      expect(parseConsent(value, NOW)).toBeNull();
    }
  });

  it('écrit un cookie de premier niveau de 6 mois, SameSite=Lax et Secure en HTTPS', () => {
    const writes: string[] = [];
    const fake = {
      location: { protocol: 'https:', hostname: 'raijinshield.com' },
      get cookie() {
        return '';
      },
      set cookie(value: string) {
        writes.push(value);
      },
    } as unknown as Document;
    writeConsent(fake, false, NOW);
    expect(writes[0]).toBe(`rj_consent=v1.denied.2026-11-22; Max-Age=${182 * 86_400}; Path=/; SameSite=Lax; Secure`);
  });

  it('lit le choix depuis le cookie du document', () => {
    expect(readConsent(document, NOW)).toBeNull();
    writeCookie(document, 'rj_consent', 'v1.granted.2026-11-20', 182);
    expect(readConsent(document, NOW)?.analytics).toBe(true);
  });
});
