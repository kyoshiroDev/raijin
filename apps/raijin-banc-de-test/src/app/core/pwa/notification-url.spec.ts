import { describe, expect, it } from 'vitest';
import { notificationUrl, safeNotificationPath } from './notification-url';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('safeNotificationPath', () => {
  it('keeps the allowed in-app paths', () => {
    expect(safeNotificationPath(`/token/${MINT}`)).toBe(`/token/${MINT}`);
    expect(safeNotificationPath('/')).toBe('/');
    expect(safeNotificationPath('/settings')).toBe('/settings');
    expect(safeNotificationPath('/alerts')).toBe('/alerts');
  });

  it.each([
    ['javascript:alert(1)'],
    ['//evil.com'],
    ['//evil.com/token/' + MINT],
    ['https://evil.com'],
    [`https://evil.com/token/${MINT}`],
    ['/token/not-a-mint'],
    ['/token/0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'],
    [`/token/${MINT}/extra`],
    [`/token/${MINT}?x=1`],
    ['/\\evil.com'],
    ['/account'],
    ['/settings/../account'],
    [' /settings'],
    [''],
  ])('falls back to / for %s', (url) => {
    expect(safeNotificationPath(url)).toBe('/');
  });

  it('falls back to / for non-strings', () => {
    expect(safeNotificationPath(undefined)).toBe('/');
    expect(safeNotificationPath(null)).toBe('/');
    expect(safeNotificationPath(42)).toBe('/');
    expect(safeNotificationPath({ toString: () => '/settings' })).toBe('/');
  });
});

describe('notificationUrl', () => {
  it('reads data.url and tolerates any shape', () => {
    expect(notificationUrl({ title: 't', data: { url: '/alerts' } })).toBe('/alerts');
    expect(notificationUrl({ title: 't' })).toBeUndefined();
    expect(notificationUrl({ data: null })).toBeUndefined();
    expect(notificationUrl(null)).toBeUndefined();
    expect(notificationUrl('x')).toBeUndefined();
  });

  it('rejects the removed radar view (falls back to the home page)', () => {
    expect(safeNotificationPath('/radar')).toBe('/');
    expect(safeNotificationPath('/radar/x')).toBe('/');
  });
});
