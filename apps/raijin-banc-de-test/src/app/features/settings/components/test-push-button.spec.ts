import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { TestPushState } from '../settings-store';
import { TestPushButton } from './test-push-button';

describe('TestPushButton', () => {
  function render(state: TestPushState, sent = 0, disabled = false) {
    const fixture = TestBed.createComponent(TestPushButton);
    fixture.componentRef.setInput('state', state);
    fixture.componentRef.setInput('sent', sent);
    fixture.componentRef.setInput('disabled', disabled);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { el, button: el.querySelector('button') as HTMLButtonElement };
  }

  it('shows « Envoyée sur N appareil(s) »', () => {
    expect(render('sent', 2).el.textContent).toContain('Envoyée sur 2 appareil(s)');
  });

  it('shows the throttle message for a 429', () => {
    expect(render('throttled').el.textContent).toContain('Patiente une minute entre deux tests');
  });

  it('shows a generic error', () => {
    expect(render('error').el.textContent).toContain('Impossible d’envoyer la notification de test');
  });

  it('is disabled while pending or when notifications are off', () => {
    const pending = render('pending');
    expect(pending.button.disabled).toBe(true);
    expect(pending.button.textContent).toContain('Envoi…');
    TestBed.resetTestingModule();
    expect(render('idle', 0, true).button.disabled).toBe(true);
    TestBed.resetTestingModule();
    expect(render('idle').button.disabled).toBe(false);
  });
});
