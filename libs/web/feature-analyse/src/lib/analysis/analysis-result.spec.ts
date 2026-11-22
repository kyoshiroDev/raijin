import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { ANALYSIS_DISCLAIMER, SAFE_VERDICT_REMINDER, type AnalysisCheck, type AnalysisResult } from '@raijin/shared-contracts';
import { fakeAnalysis } from '@raijin/web-data-access';
import { RjAnalysisResult } from './analysis-result';
import { RjCheckItem } from './check-item';

function checkAt(index: number): AnalysisCheck {
  const check = fakeAnalysis('safe').checks[index];
  if (!check) throw new Error('Contrôle absent');
  return check;
}

/** Rendu du résultat ; `checks: false` laisse les 9 contrôles sur leur placeholder (`@defer`). */
async function renderResult(result: AnalysisResult, mode: 'private' | 'public' = 'private', checks = true) {
  TestBed.configureTestingModule({ deferBlockBehavior: DeferBlockBehavior.Manual });
  const fixture = TestBed.createComponent(RjAnalysisResult);
  fixture.componentRef.setInput('result', result);
  fixture.componentRef.setInput('mode', mode);
  await fixture.whenStable();
  if (checks) {
    for (const block of await fixture.getDeferBlocks()) await block.render(DeferBlockState.Complete);
    await fixture.whenStable();
  }
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

async function renderCheck(check: AnalysisCheck, expanded = true) {
  const fixture = TestBed.createComponent(RjCheckItem);
  fixture.componentRef.setInput('check', check);
  fixture.componentRef.setInput('expanded', expanded);
  await fixture.whenStable();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

describe('RjCheckItem', () => {
  it.each([
    ['ok', 'OK', 'text-safe'],
    ['warn', 'Attention', 'text-warn'],
    ['danger', 'Danger', 'text-danger'],
    ['unavailable', 'Indisponible', 'text-ink-muted'],
  ] as const)('statut %s : icône + mot « %s »', async (status, word, color) => {
    const check = { ...checkAt(0), status };
    const { host } = await renderCheck(check, false);
    const label = host.querySelector('[data-status]') as HTMLElement;
    expect(label.textContent?.trim()).toBe(word);
    expect(label.className).toContain(color);
    expect(host.querySelector('button svg')).not.toBeNull();
  });

  it('accordéon : aria-expanded et région liée', async () => {
    const { fixture, host } = await renderCheck(checkAt(2), false);
    const toggle = host.querySelector('h3 button') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[role="region"]')).toBeNull();
    toggle.click();
    await fixture.whenStable();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const region = host.querySelector('[role="region"]') as HTMLElement;
    expect(region.id).toBe(toggle.getAttribute('aria-controls'));
    expect(region.getAttribute('aria-labelledby')).toBe(toggle.id);
  });

  it('valeurs : compactes en mono, valeur exacte en title', async () => {
    const { host } = await renderCheck(checkAt(2));
    const value = host.querySelector('dd') as HTMLElement;
    expect(value.className).toContain('tabular');
    expect(value.getAttribute('title')).toContain('284');
    expect(value.querySelector('[aria-hidden="true"]')?.textContent).toContain('M$');
  });

  it('RugCheck : présenté comme avis externe', async () => {
    const { host } = await renderCheck(checkAt(8));
    expect(host.querySelector('[data-external-note]')?.textContent).toContain('service externe');
    TestBed.resetTestingModule();
    const other = await renderCheck(checkAt(0));
    expect(other.host.querySelector('[data-external-note]')).toBeNull();
  });

  it('liens de source : uniquement https sur liste blanche, rel sûr, nouvel onglet', async () => {
    const check: AnalysisCheck = {
      ...checkAt(2),
      sources: [
        { id: 'dexscreener', name: 'DexScreener', url: 'https://dexscreener.com/solana/x' },
        { id: 'geckoterminal', name: 'GeckoTerminal', url: 'javascript:alert(1)' },
        { id: 'rugcheck', name: 'RugCheck', url: 'https://rugcheck.xyz.evil.io/x' },
      ],
    };
    const { host } = await renderCheck(check);
    const links = Array.from(host.querySelectorAll('a'));
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://dexscreener.com/solana/x');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(host.textContent).toContain('GeckoTerminal');
    expect(host.textContent).toContain('RugCheck');
  });
});

describe('RjAnalysisResult', () => {
  it('Sain : verdict icône + mot, rappel « aucun signal ≠ sans risque », mention légale', async () => {
    const { host } = await renderResult(fakeAnalysis('safe'));
    const verdict = host.querySelector('[data-verdict-block] [role="status"]') as HTMLElement;
    expect(verdict.getAttribute('aria-label')).toBe('Verdict : Sain');
    expect(verdict.querySelector('svg')).not.toBeNull();
    expect(verdict.textContent?.trim()).toBe('Sain');
    expect(host.textContent).toContain(SAFE_VERDICT_REMINDER);
    expect(host.querySelector('[data-disclaimer]')?.textContent).toBe(ANALYSIS_DISCLAIMER);
    expect(host.querySelectorAll('rj-check-item')).toHaveLength(9);
  });

  it('verdict d’abord : les 9 contrôles attendent l’inactivité derrière un placeholder de 9 lignes', async () => {
    const { host } = await renderResult(fakeAnalysis('safe'), 'private', false);
    expect(host.querySelector('[data-verdict-block]')?.textContent).toContain('Sain');
    expect(host.querySelectorAll('rj-check-item')).toHaveLength(0);
    const placeholder = host.querySelector('[data-checks-placeholder]') as HTMLElement;
    expect(placeholder.getAttribute('aria-busy')).toBe('true');
    expect(placeholder.querySelectorAll('li')).toHaveLength(9);
    expect(placeholder.querySelector('li')?.className).toContain('min-h-16');
  });

  it('Danger : pas de rappel Sain, phrase d’explication', async () => {
    const { host } = await renderResult(fakeAnalysis('danger'));
    expect(host.textContent).not.toContain(SAFE_VERDICT_REMINDER);
    expect(host.querySelector('[data-explanation]')?.textContent).toContain('autorité de mint');
    expect(host.querySelector('[data-verdict-block]')?.className).toContain('text-danger');
  });

  it('nom de token hostile : rendu comme texte, jamais comme HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const result = fakeAnalysis('safe');
    const { host } = await renderResult({ ...result, token: { ...result.token, name: hostile, symbol: '<b>X</b>' } });
    expect(host.querySelector('[data-token-name]')?.textContent).toBe(hostile);
    expect(host.querySelector('[data-token-symbol]')?.textContent).toBe('<b>X</b>');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('non fiable');
  });

  it('résultat partiel : contrôles indisponibles signalés', async () => {
    const { host } = await renderResult(fakeAnalysis('degraded'));
    expect(host.querySelector('[data-degraded]')?.textContent).toContain('3 contrôles n’ont pas pu être vérifiés');
    expect(host.textContent).toContain('Indisponible');
    expect(host.querySelector('[data-token-name]')?.textContent).toBe('Nom non publié');
    expect(host.textContent).not.toContain('non fiable');
  });

  it('privé : « Suivre » désactivé (bientôt) ; public : pas de « Suivre »', async () => {
    const privateView = await renderResult(fakeAnalysis('warn'));
    const follow = Array.from(privateView.host.querySelectorAll('button')).find((b) => b.textContent?.includes('Suivre'));
    expect(follow?.disabled).toBe(true);
    expect(follow?.textContent).toContain('bientôt');
    TestBed.resetTestingModule();
    const publicView = await renderResult(fakeAnalysis('warn'), 'public');
    expect(Array.from(publicView.host.querySelectorAll('button')).some((b) => b.textContent?.includes('Suivre'))).toBe(false);
    expect(Array.from(publicView.host.querySelectorAll('button')).some((b) => b.textContent?.includes('Partager'))).toBe(true);
  });

  it('« En savoir plus » ouvre la bottom sheet pédagogique du contrôle', async () => {
    const { fixture, host } = await renderResult(fakeAnalysis('safe'));
    (host.querySelector('rj-check-item h3 button') as HTMLButtonElement).click();
    await fixture.whenStable();
    (host.querySelector('button[aria-label="En savoir plus : Autorité de mint"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.querySelector('h2')?.textContent).toBe('Autorité de mint');
    expect(dialog.textContent).toContain('Comment Raijin le vérifie');
  });

  it('aucune action jaune dans le résultat privé', async () => {
    const { host } = await renderResult(fakeAnalysis('safe'));
    expect(host.querySelectorAll('.bg-thunder')).toHaveLength(0);
  });
});
