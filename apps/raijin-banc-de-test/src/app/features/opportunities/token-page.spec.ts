import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPABASE } from '../../core/supabase/supabase-client';
import { TokenPage } from './token-page';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('TokenPage (/token/:mint)', () => {
  let result: { data: unknown; error: unknown };
  const eq = vi.fn();
  const from = vi.fn();

  beforeEach(() => {
    result = { data: null, error: null };
    const query = {
      select: vi.fn(() => query),
      eq: eq.mockImplementation(() => query),
      abortSignal: vi.fn(() => query),
      maybeSingle: vi.fn(async () => result),
    };
    from.mockReset().mockReturnValue(query);
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: SUPABASE, useValue: { from } }] });
  });

  async function render(mint: string) {
    const fixture = TestBed.createComponent(TokenPage);
    fixture.componentRef.setInput('mint', mint);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows « Token introuvable » for an invalid mint without querying Supabase', async () => {
    for (const bad of ['', 'not-a-mint', '<script>', `${MINT}0`, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDtlv']) {
      const el = await render(bad);
      expect(el.textContent).toContain('Token introuvable');
      expect(el.querySelector('a[href="/"]')).not.toBeNull();
    }
    expect(from).not.toHaveBeenCalled();
  });

  it('shows « Token introuvable » for a valid but unknown mint', async () => {
    const el = await render(MINT);
    expect(from).toHaveBeenCalledWith('tokens');
    expect(eq).toHaveBeenCalledWith('mint', MINT);
    expect(el.textContent).toContain('Token introuvable');
  });

  it('renders the detail when the token exists', async () => {
    result = {
      data: { mint: MINT, symbol: 'GTA6', name: 'GTA VI', flags: [] },
      error: null,
    };
    const el = await render(MINT);
    expect(el.querySelector('app-token-detail')).not.toBeNull();
    expect(el.querySelector('h1')?.textContent).toContain('GTA6');
    expect(el.textContent).not.toContain('Token introuvable');
  });

  it('shows « Token introuvable » (with a generic reason) when the query fails', async () => {
    result = { data: null, error: { message: 'raw db error' } };
    const el = await render(MINT);
    expect(el.textContent).toContain('Token introuvable');
    expect(el.textContent).not.toContain('raw db error');
  });
});
