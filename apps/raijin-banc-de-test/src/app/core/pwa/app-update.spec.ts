import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SwUpdate, type UnrecoverableStateEvent, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../app';
import { AppUpdate, PAGE_RELOAD } from './app-update';

describe('AppUpdate + update toast', () => {
  function setup(isEnabled = true) {
    const versionUpdates = new Subject<VersionEvent>();
    const unrecoverable = new Subject<UnrecoverableStateEvent>();
    const order: string[] = [];
    const activateUpdate = vi.fn(async () => {
      order.push('activate');
      return true;
    });
    const reload = vi.fn(() => order.push('reload'));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: SwUpdate, useValue: { isEnabled, versionUpdates, unrecoverable, activateUpdate } },
        { provide: PAGE_RELOAD, useValue: reload },
      ],
    });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const toast = () => el.querySelector('app-update-toast');
    const button = (label: string) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('app-update-toast button')).find(
        (b) => b.textContent?.includes(label) || b.getAttribute('aria-label')?.includes(label),
      );
    const ready = () =>
      versionUpdates.next({ type: 'VERSION_READY', currentVersion: { hash: 'a' }, latestVersion: { hash: 'b' } });
    return { fixture, toast, button, ready, versionUpdates, unrecoverable, activateUpdate, reload, order };
  }

  it('shows « Nouvelle version disponible » only on VERSION_READY', async () => {
    const { fixture, toast, ready, versionUpdates } = setup();
    versionUpdates.next({ type: 'VERSION_DETECTED', version: { hash: 'b' } });
    versionUpdates.next({ type: 'NO_NEW_VERSION_DETECTED', version: { hash: 'a' } });
    await fixture.whenStable();
    expect(toast()).toBeNull();
    ready();
    await fixture.whenStable();
    expect(toast()?.textContent).toContain('Nouvelle version disponible');
  });

  it('« Recharger » activates the update, then reloads', async () => {
    const { fixture, button, ready, activateUpdate, reload, order } = setup();
    ready();
    await fixture.whenStable();
    button('Recharger')?.click();
    await fixture.whenStable();
    expect(activateUpdate).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['activate', 'reload']);
  });

  it('reloads even if activateUpdate fails', async () => {
    const { activateUpdate, reload } = setup();
    activateUpdate.mockRejectedValueOnce(new Error('x'));
    await TestBed.inject(AppUpdate).reload();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('dismiss hides the toast without reloading', async () => {
    const { fixture, toast, button, ready, reload } = setup();
    ready();
    await fixture.whenStable();
    button('Ignorer')?.click();
    await fixture.whenStable();
    expect(toast()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads on an unrecoverable state', () => {
    const { unrecoverable, reload } = setup();
    unrecoverable.next({ type: 'UNRECOVERABLE_STATE', reason: 'missing file' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe when the service worker is disabled', () => {
    const { versionUpdates, unrecoverable } = setup(false);
    expect(versionUpdates.observed).toBe(false);
    expect(unrecoverable.observed).toBe(false);
  });
});
