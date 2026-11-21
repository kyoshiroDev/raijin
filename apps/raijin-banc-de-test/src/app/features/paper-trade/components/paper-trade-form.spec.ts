import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { formatPrice } from '../../../shared/utils/format';
import { DRAFT_ERRORS, type PaperDraft } from '../paper-strategy';
import { PaperTradeForm } from './paper-trade-form';

const INITIAL: PaperDraft = { stake: 0.05, entry: 0.00013, slPct: 30 };

function setup(opts: { initial?: PaperDraft; available?: number | null; error?: string | null } = {}) {
  const fixture = TestBed.createComponent(PaperTradeForm);
  fixture.componentRef.setInput('initial', opts.initial ?? INITIAL);
  fixture.componentRef.setInput('available', opts.available === undefined ? 1 : opts.available);
  if (opts.error !== undefined) fixture.componentRef.setInput('error', opts.error);
  const emitted: PaperDraft[] = [];
  fixture.componentInstance.submitted.subscribe((d) => emitted.push(d));
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const input = (f: string) => el.querySelector<HTMLInputElement>(`[data-field="${f}"]`);
  const type = (f: string, value: string) => {
    const i = input(f) as HTMLInputElement;
    i.value = value;
    i.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const submit = () => el.querySelector<HTMLButtonElement>('button[type="submit"]') as HTMLButtonElement;
  const sum = (k: string) => el.querySelector(`[data-sum="${k}"] dd`)?.textContent?.trim();
  return { el, input, type, submit, sum, emitted };
}

describe('PaperTradeForm', () => {
  it('shows the fixed « tout à ×2 » strategy and the market entry (not editable), pre-fills stake and stop %', () => {
    const { el, input } = setup();
    expect(el.querySelector('input[type="radio"]')).toBeNull();
    expect(el.querySelector('[data-strategy="all_x2"]')?.textContent).toContain('Stratégie : tout à ×2');
    expect(el.querySelector('[data-entry]')?.textContent).toContain(`Entrée au prix actuel (${formatPrice(0.00013)})`);
    expect(input('entry')).toBeNull();
    expect(input('customTp')).toBeNull();
    expect(input('stake')?.value).toBe('0,05');
    expect(input('slPct')?.value).toBe('30');
  });

  it('summarises the ×2 target, the stop, 2 transactions, rent and the target / stop scenarios', () => {
    const { el, sum } = setup();
    expect(sum('tp-all')).toBe(formatPrice(0.00026));
    expect(sum('sl')).toBe(formatPrice(0.000091));
    expect(el.querySelector('[data-sum="breakeven"]')).toBeNull();
    expect(el.querySelector('[data-sum="fees"] dt')?.textContent).toContain('2 transactions');
    expect(sum('fees')).toBe('0,0004 SOL');
    expect(sum('rent')).toBe('0,002 SOL');
    expect(Array.from(el.querySelectorAll('[data-scenario]')).map((n) => n.getAttribute('data-scenario'))).toEqual(['tp', 'sl']);
    expect(el.querySelector('[data-scenario="tp"] dd')?.textContent).toContain('+');
    expect(el.querySelector('[data-scenario="sl"] dd')?.textContent).toContain('−');
  });

  it('lets the stake (French comma) and the stop be edited and emits numbers, entry kept at the market price', () => {
    const { type, submit, emitted } = setup();
    type('stake', '0,2');
    type('slPct', '25');
    submit().click();
    expect(emitted).toEqual([{ stake: 0.2, entry: 0.00013, slPct: 25 }]);
  });

  it('blocks an invalid stop % and a stake above the virtual balance, with messages', () => {
    const { el, type, submit, input, emitted } = setup({ available: 0.1 });
    type('slPct', '95');
    expect(input('slPct')?.getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain(DRAFT_ERRORS.slPct);
    type('slPct', '30');
    type('stake', '0,1');
    expect(el.textContent).toContain(DRAFT_ERRORS.balance);
    expect(submit().disabled).toBe(true);
    submit().click();
    expect(emitted).toEqual([]);
    expect(el.querySelector('[data-trade-summary]')?.textContent).toContain('Corrige les champs');
  });

  it('shows the generic submit error', () => {
    const { el } = setup({ error: 'Solde virtuel insuffisant' });
    expect(el.querySelector('[data-submit-error]')?.textContent?.trim()).toBe('Solde virtuel insuffisant');
  });
});
