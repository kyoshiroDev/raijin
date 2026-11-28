import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { NotificationClicks } from './notification-clicks';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
interface Click {
  action: string;
  notification: NotificationOptions & { title: string };
}

describe('NotificationClicks', () => {
  function setup(isEnabled = true) {
    const clicks = new Subject<Click>();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: SwPush, useValue: { isEnabled, notificationClicks: clicks } }],
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    TestBed.inject(NotificationClicks);
    const click = (data: unknown) => clicks.next({ action: '', notification: { title: 'x', data } });
    return { click, navigate, clicks };
  }

  it('navigates to a valid token path', () => {
    const { click, navigate } = setup();
    click({ url: `/token/${MINT}` });
    expect(navigate).toHaveBeenCalledWith(`/token/${MINT}`);
  });

  it.each(['javascript:alert(1)', '//evil.com', 'https://evil.com', '/token/invalid', undefined])(
    'sends %s to /',
    (url) => {
      const { click, navigate } = setup();
      click({ url });
      expect(navigate).toHaveBeenCalledWith('/');
    },
  );

  it('does nothing when the service worker is disabled', () => {
    const { clicks, navigate } = setup(false);
    expect(clicks.observed).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('unsubscribes when the injector is destroyed', () => {
    const { clicks } = setup();
    expect(clicks.observed).toBe(true);
    TestBed.resetTestingModule();
    expect(clicks.observed).toBe(false);
  });
});
