import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_SETTINGS, type AlertPreferences, type AlertSettings } from '../alert-settings';
import { AlertSettingsForm } from './alert-settings-form';

describe('AlertSettingsForm', () => {
  function setup(over: Partial<AlertSettings> = {}) {
    const fixture = TestBed.createComponent(AlertSettingsForm);
    fixture.componentRef.setInput('settings', { ...DEFAULT_ALERT_SETTINGS, enabled: true, ...over });
    const emitted: AlertPreferences[] = [];
    fixture.componentInstance.save.subscribe((p) => emitted.push(p));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const submit = () => el.querySelector<HTMLButtonElement>('button[type="submit"]') as HTMLButtonElement;
    const type = (selector: string, value: string, event = 'input') => {
      const input = el.querySelector<HTMLInputElement | HTMLSelectElement>(selector) as HTMLInputElement | HTMLSelectElement;
      input.value = value;
      input.dispatchEvent(new Event(event));
      fixture.detectChanges();
    };
    return { el, fixture, emitted, submit, type };
  }

  it('shows the defaults', () => {
    const { el } = setup();
    expect(el.querySelector('#alert-min-score')).toBeNull();
    expect(el.querySelector<HTMLInputElement>('#alert-max-per-hour')?.value).toBe('4');
    expect(el.textContent).toContain('23 h → 7 h');
  });

  it('blocks an out-of-range value with a message', () => {
    const { el, submit, type, emitted } = setup();
    type('#alert-max-per-hour', '25');
    expect(el.textContent).toContain('entre 1 et 20');
    expect(submit().disabled).toBe(true);
    submit().click();
    expect(emitted).toEqual([]);
  });

  it('shows the stake field (decimal keypad, bounds) with the stored value in French format', () => {
    const { el } = setup();
    const input = el.querySelector<HTMLInputElement>('#alert-stake-sol');
    expect(input?.value).toBe('0,05');
    expect(input?.getAttribute('inputmode')).toBe('decimal');
    expect(input?.getAttribute('min')).toBe('0.01');
    expect(input?.getAttribute('max')).toBe('100');
    expect(input?.getAttribute('step')).toBe('0.01');
    expect(el.querySelector('label[for="alert-stake-sol"]')?.textContent).toContain('Ma mise habituelle (SOL)');
  });

  it('accepts a French decimal comma for the stake (« 0,25 » → 0.25)', () => {
    const { submit, type, emitted } = setup();
    type('#alert-stake-sol', '0,25');
    expect(submit().disabled).toBe(false);
    submit().click();
    expect(emitted[0]?.stake_sol).toBe(0.25);
  });

  it('rejects a stake below 0.01 or above 100 SOL, or malformed', () => {
    const { el, submit, type, emitted } = setup();
    for (const bad of ['0.005', '0,005', '101', 'abc', '', '1,2,3']) {
      type('#alert-stake-sol', bad);
      expect(el.textContent).toContain('entre 0,01 et 100 SOL');
      expect(el.querySelector('#alert-stake-sol')?.getAttribute('aria-invalid')).toBe('true');
      expect(submit().disabled).toBe(true);
    }
    submit().click();
    expect(emitted).toEqual([]);
    type('#alert-stake-sol', '100');
    expect(submit().disabled).toBe(false);
  });

  it('emits the edited preferences on « Enregistrer »', () => {
    const { submit, type, emitted, el } = setup();
    type('#alert-max-per-hour', '6');
    const selects = el.querySelectorAll('select');
    selects[0].value = '22';
    selects[0].dispatchEvent(new Event('change'));
    submit().click();
    expect(emitted).toEqual([
      {
        hide_bonding_curve: true,
        quiet_start: 22,
        quiet_end: 7,
        max_per_hour: 6,
        max_per_day: 30,
        stake_sol: 0.05,
        auto_paper: false,
        paper_sl_pct: 30,
      },
    ]);
  });

  it('shows the Auto-paper switch off by default, with its simulation description', () => {
    const { el } = setup();
    const sw = el.querySelector<HTMLInputElement>('#alert-auto-paper');
    expect(sw?.getAttribute('role')).toBe('switch');
    expect(sw?.checked).toBe(false);
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    expect(el.querySelector('[data-auto-paper]')?.textContent).toContain(
      'Chaque alerte envoyée ouvre automatiquement un paper trade tout à ×2 avec mon stop par défaut',
    );
    const text = el.querySelector('[data-auto-paper]')?.textContent?.replace(/\s+/g, ' ');
    expect(text).toContain('trois portefeuilles de test (Calme SL −30 %, Calme SL −40 %, Frénésie SL −30 % en témoin)');
  });

  it('emits auto_paper: true once the Auto-paper switch is turned on', () => {
    const { el, fixture, submit, emitted } = setup();
    const sw = el.querySelector<HTMLInputElement>('#alert-auto-paper') as HTMLInputElement;
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(sw.getAttribute('aria-checked')).toBe('true');
    submit().click();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].auto_paper).toBe(true);
  });

  it('shows the « Paper trading » section: fixed « tout à ×2 » (no strategy selector), stop 30 %, stake reminder', () => {
    const { el } = setup();
    const section = el.querySelector('[data-paper-settings]') as HTMLElement;
    expect(section.textContent).toContain('Paper trading');
    expect(section.textContent).toContain('Simulation — aucun argent réel');
    expect(section.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(section.querySelector('[data-paper-strategy]')?.textContent).toContain('Stratégie : tout à ×2.');
    expect(el.querySelector<HTMLInputElement>('#paper-sl-pct')?.value).toBe('30');
    expect(section.textContent).toContain('0,05 SOL');
    expect(el.querySelector('[data-auto-paper-parallel]')).toBeNull();
  });

  it('emits the stop with the other preferences, and blocks an invalid stop', () => {
    const { el, submit, type, emitted } = setup();
    type('#paper-sl-pct', '95');
    expect(submit().disabled).toBe(true);
    expect(el.textContent).toContain('Le stop par défaut doit être un entier entre 1 et 90 %.');
    type('#paper-sl-pct', '25');
    submit().click();
    expect(emitted[0]).toMatchObject({ paper_sl_pct: 25 });
    expect('paper_default_strategy' in emitted[0]).toBe(false);
  });

  it('shows « Jeune calme » as fixed information (no profile selector, no score / zone / model / Radar / Jeune & fort controls)', () => {
    const { el } = setup();
    const profile = el.querySelector('[data-alert-profile]');
    expect(profile?.querySelector('h3')?.textContent).toContain('Profil d’alertes : Jeune calme');
    expect(profile?.textContent).toContain('ratio achats/ventes 1 h entre 0,8 et 1,3');
    expect(profile?.textContent?.replace(/\s+/g, ' ')).toContain('pas de Structure cassée');
    expect(el.querySelectorAll('input[name="alert-preset"]')).toHaveLength(0);
    for (const sel of ['#alert-min-score', '[data-strict-controls]', '[data-model-thresholds]', '[data-radar-alerts]', '#alert-young-strong', '[data-alert-preset]']) {
      expect(el.querySelector(sel)).toBeNull();
    }
    expect(el.textContent).not.toContain('Seulement dans la zone');
  });

  describe('caps', () => {
    it('shows « 4 alertes / heure, 30 / jour » by default', () => {
      const { el } = setup();
      expect(el.querySelector<HTMLInputElement>('#alert-max-per-day')?.value).toBe('30');
      expect(el.querySelector('[data-caps-summary]')?.textContent?.replace(/\s+/g, ' ')).toContain('4 alertes / heure, 30 / jour');
    });

    it('edits max_per_day within 1–100 and blocks anything else', () => {
      const { el, submit, type, emitted } = setup();
      for (const bad of ['0', '101', '2.5', '']) {
        type('#alert-max-per-day', bad);
        expect(el.textContent).toContain('entre 1 et 100');
        expect(submit().disabled).toBe(true);
      }
      type('#alert-max-per-day', '50');
      submit().click();
      expect(emitted[0]?.max_per_day).toBe(50);
    });
  });
});
