import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeBenchApi, apiError, provideFakeBench } from '../../core/api/bench-api.testing';
import { TokenPage } from './token-page';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('TokenPage (/token/:mint)', () => {
  /** `data: null` = 404 (token inconnu) ; `error` = échec de l'API. */
  let result: { data: unknown; error: unknown };
  let api: FakeBenchApi;
  const tokenCalls = () => api.callsTo('GET', BENCH_ROUTES.token);

  beforeEach(() => {
    result = { data: null, error: null };
    api = new FakeBenchApi().on('GET', BENCH_ROUTES.token, () => {
      if (result.error) throw apiError(500, 'INTERNAL_ERROR', 'raw db error');
      if (result.data === null) throw apiError(404, 'NOT_FOUND');
      return result.data;
    });
    TestBed.configureTestingModule({ providers: [provideRouter([]), ...provideFakeBench(api)] });
  });

  async function render(mint: string) {
    const fixture = TestBed.createComponent(TokenPage);
    fixture.componentRef.setInput('mint', mint);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows « Token introuvable » for an invalid mint without querying the API', async () => {
    for (const bad of ['', 'not-a-mint', '<script>', `${MINT}0`, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDtlv']) {
      const el = await render(bad);
      expect(el.textContent).toContain('Token introuvable');
      expect(el.querySelector('a[href="/"]')).not.toBeNull();
    }
    expect(tokenCalls()).toHaveLength(0);
  });

  it('shows « Token introuvable » for a valid but unknown mint', async () => {
    const el = await render(MINT);
    expect(tokenCalls()[0]?.params).toEqual({ mint: MINT });
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
