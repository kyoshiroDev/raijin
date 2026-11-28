import { WALLET_REVOKE_GUIDE_URLS } from '@raijin/shared-contracts';
import {
  WALLET_FIXTURES,
  fakeWalletDelegation,
  fakeWalletQuotaResponse,
  fakeWalletScan,
  fakeWalletScanResponse,
  fakeWalletToken,
} from '@raijin/web-data-access';
import { QUOTA, SCANS, button, expectRequest, query, queryAll, root, setupFeature, stable, submitForm, typeInput, waitFor } from '../testing/harness';

vi.setConfig({ testTimeout: 30_000 });

const { wallet: WALLET, mints } = WALLET_FIXTURES;

/** Pro : `/wallet` ouvert, accès accordé, formulaire affiché. */
async function openPro(quota = fakeWalletQuotaResponse()) {
  const env = await setupFeature();
  void env.harness.navigateByUrl('/wallet');
  (await expectRequest(env.ctrl, QUOTA)).flush(quota);
  await waitFor(() => query(env.harness, 'input[name="wallet"]') !== null);
  await stable(env.harness);
  return env;
}

async function scan(env: Awaited<ReturnType<typeof openPro>>, body: object, init?: { status: number; statusText: string }) {
  typeInput(env.harness, WALLET);
  submitForm(env.harness);
  const req = await expectRequest(env.ctrl, SCANS);
  req.flush(body, init);
  await stable(env.harness);
  return req;
}

function primaries(harness: Awaited<ReturnType<typeof openPro>>['harness']): HTMLElement[] {
  return queryAll(harness, '.bg-thunder');
}

describe('WalletPage', () => {
  it('visiteur : explication du scan, inscription et connexion avec retour, aucune requête, une seule action jaune', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl('/wallet');
    await waitFor(() => query(harness, '[data-access="signed-out"]') !== null);
    await stable(harness);
    ctrl.expectNone(QUOTA);
    expect(query(harness, 'input')).toBeNull();
    expect(query(harness, '[data-read-only]')?.textContent).toContain('Aucune connexion de wallet, aucune signature');
    expect(query(harness, 'a[href="/compte/inscription?redirect=%2Fwallet"]')).not.toBeNull();
    expect(query(harness, 'a[href="/compte/connexion?redirect=%2Fwallet"]')).not.toBeNull();
    expect(primaries(harness)).toHaveLength(1);
    expect(root(harness).textContent).toContain('pas un conseil en investissement');
  });

  it('plan Gratuit : explication et essai Pro sans urgence, pas de formulaire', async () => {
    const { harness, ctrl } = await setupFeature('authenticated', { plan: 'FREE', emailVerified: false });
    void harness.navigateByUrl('/wallet');
    (await expectRequest(ctrl, QUOTA)).flush(fakeWalletQuotaResponse(false));
    await waitFor(() => query(harness, '[data-access="plan"]') !== null);
    await stable(harness);
    expect(query(harness, 'input')).toBeNull();
    expect(query(harness, '[data-plan-text]')?.textContent).toContain('essai Pro de 7 jours');
    expect(query(harness, '[data-plan-text]')?.textContent).toContain('sans carte bancaire');
    expect(query(harness, 'a[href="/compte/verifier-email"]')).not.toBeNull();
    expect(primaries(harness)).toHaveLength(1);
    expect(root(harness).textContent).not.toMatch(/dépêche|dernière chance/i);
  });

  it('validation : adresse invalide refusée sans requête, mint proposé à l’analyse, phrase de récupération refusée', async () => {
    const env = await openPro();
    const { harness, ctrl } = env;
    expect(query(harness, '[data-quota]')?.textContent).toContain('20');
    submitForm(harness);
    await stable(harness);
    expect(root(harness).textContent).toContain('Colle l’adresse publique d’un wallet');

    typeInput(harness, 'pas-une-adresse');
    submitForm(harness);
    await stable(harness);
    expect(root(harness).textContent).toContain('Adresse invalide');
    ctrl.expectNone(SCANS);

    typeInput(harness, mints.usdc);
    await stable(harness);
    expect(root(harness).textContent).toContain('C’est l’adresse d’un token');
    expect(query(harness, '[data-analyse-token]')?.getAttribute('href')).toBe(`/analyse/${mints.usdc}`);
    submitForm(harness);
    ctrl.expectNone(SCANS);

  });

  it('phrase de récupération : champ et signal vidés aussitôt, message clair, valeur conservée nulle part', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { harness, ctrl, router } = await openPro();
    const seed = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    typeInput(harness, seed);
    await stable(harness);
    const field = query<HTMLInputElement>(harness, 'input[name="wallet"]');
    expect(field?.value).toBe('');
    expect(root(harness).textContent).toContain('On ne te demande jamais ta phrase de récupération. Ne la colle nulle part');
    expect(root(harness).textContent).not.toContain('sausage');
    expect(root(harness).innerHTML).not.toContain('sausage');
    expect(router.url).toBe('/wallet');
    expect(window.history.state ? JSON.stringify(window.history.state) : '').not.toContain('sausage');
    for (const call of setItem.mock.calls) expect(call.join(' ')).not.toContain('sausage');
    submitForm(harness);
    ctrl.expectNone(SCANS);
    setItem.mockRestore();

    typeInput(harness, WALLET);
    await stable(harness);
    expect(root(harness).textContent).not.toContain('On ne te demande jamais');
    expect(root(harness).textContent).toContain('Adresse reconnue');
  });

  it('phrase de récupération via le bouton « Coller » : champ vidé, aucun scan, message affiché (phase 5 m4)', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const seed = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn(async () => seed) }, configurable: true });
    try {
      const { harness, ctrl } = await openPro();
      button(harness, 'Coller')?.click();
      await waitFor(() => (root(harness).textContent ?? '').includes('On ne te demande jamais ta phrase de récupération'));
      await stable(harness);
      expect(query<HTMLInputElement>(harness, 'input[name="wallet"]')?.value).toBe('');
      expect(root(harness).innerHTML).not.toContain('sausage');
      submitForm(harness);
      ctrl.expectNone(SCANS);
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as { clipboard?: Clipboard }).clipboard;
    }
  });

  it('scan : adresse dans le corps du POST seulement, jamais dans l’URL ni dans le stockage du navigateur', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const env = await openPro();
    const req = await scan(env, fakeWalletScanResponse());
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ address: WALLET });
    expect(req.request.urlWithParams).not.toContain(WALLET);
    expect(env.router.url).toBe('/wallet');
    expect(window.location.href).not.toContain(WALLET);
    for (const call of setItem.mock.calls) expect(call.join(' ')).not.toContain(WALLET);
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i++) expect(storage.getItem(storage.key(i) ?? '') ?? '').not.toContain(WALLET);
    }
    expect(document.cookie).not.toContain(WALLET);
    setItem.mockRestore();
  });

  it('résultat : délégations en tête, résumé, cartes verdict icône + mot, profondeur, solde exact en title, lien d’analyse', async () => {
    const env = await openPro();
    const delegation = fakeWalletDelegation();
    await scan(env, fakeWalletScanResponse(fakeWalletScan(undefined, [delegation], {}), { remaining: 18 }));
    const { harness } = env;
    const result = query(harness, '[data-result]');
    const sections = Array.from(result?.querySelectorAll('[data-delegations], [data-summary], [data-tokens]') ?? []);
    expect(sections.map((el) => el.getAttribute('data-delegations') !== null ? 'delegations' : el.hasAttribute('data-summary') ? 'summary' : 'tokens')).toEqual([
      'delegations',
      'summary',
      'tokens',
    ]);

    const item = query(harness, '[data-delegation]');
    expect(item?.textContent).toContain('USD Coin');
    expect(item?.querySelector('[data-full-balance]')?.textContent).toContain('Tout le solde');
    expect(item?.querySelector('[data-delegated-amount]')?.textContent?.trim()).toBe('Illimité');
    expect(item?.querySelector('rj-address-chip')?.textContent).toContain(delegation.delegate);
    expect(query(harness, '[data-delegations]')?.textContent).toContain('sans te redemander ton accord');
    expect(button(harness, 'Révoquer')).toBeUndefined();

    expect(query(harness, '[data-token-count]')?.textContent?.trim()).toBe('5');
    expect(query(harness, '[data-verdict-count="danger"]')?.textContent).toContain('Danger');
    expect(query(harness, '[data-quota]')?.textContent).toContain('18');

    const cards = queryAll(harness, 'rj-wallet-token-card');
    expect(cards).toHaveLength(5);
    const bonk = cards[1];
    expect(bonk?.querySelector('rj-verdict-badge')?.textContent).toContain('Sain');
    expect(bonk?.querySelector('rj-verdict-badge rj-icon')).not.toBeNull();
    expect(bonk?.querySelector('[data-coverage]')?.textContent).toContain('Contrôle rapide (6/9)');
    expect(cards[0]?.querySelector('[data-coverage]')?.textContent).toContain('Analyse complète (9/9)');
    expect(bonk?.querySelector('[data-balance]')?.getAttribute('title')).toBe('1 234 567,89 BONK');
    expect(bonk?.querySelector('[data-analysis-link]')?.getAttribute('href')).toBe(`/analyse/${mints.bonk}`);
    expect(cards[3]?.querySelector('[data-status]')?.textContent).toContain('Non analysé');
    expect(cards[4]?.querySelector('[data-status]')?.textContent).toContain('Indisponible');
    expect(root(harness).textContent).toContain('Sain : aucun signal détecté ne veut pas dire sans risque.');
    expect(primaries(harness)).toHaveLength(1);
  });

  it('liens de révocation : liste blanche exacte uniquement, nouvel onglet, rel="noopener noreferrer"', async () => {
    const env = await openPro();
    await scan(env, fakeWalletScanResponse(fakeWalletScan(undefined, [fakeWalletDelegation()])));
    const links = queryAll<HTMLAnchorElement>(env.harness, '[data-delegations] a[href^="http"]');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([...WALLET_REVOKE_GUIDE_URLS]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('nom de token hostile : rendu comme du texte, aucun élément injecté', async () => {
    const env = await openPro();
    const hostile = fakeWalletToken({
      token: { mint: mints.bonk, name: '<img src=x onerror="alert(1)">Bonk', symbol: '<b>B</b>', decimals: 5, tokenProgram: 'spl-token', untrusted: true },
    });
    await scan(env, fakeWalletScanResponse(fakeWalletScan([hostile])));
    const card = query(env.harness, 'rj-wallet-token-card');
    expect(card?.querySelector('img')).toBeNull();
    expect(card?.querySelector('b')).toBeNull();
    expect(card?.querySelector('[data-token-name]')?.textContent).toContain('<img');
  });

  it('wallet vide : Rai bravo « aucun token »', async () => {
    const env = await openPro();
    await scan(env, fakeWalletScanResponse(fakeWalletScan([], [], { summary: { nftCount: 2 } })));
    expect(query(env.harness, 'rj-empty-state img')?.getAttribute('src')).toContain('rai-bravo.svg');
    expect(query(env.harness, 'rj-empty-state')?.textContent).toContain('Aucun token');
    expect(queryAll(env.harness, 'rj-mascot')).toHaveLength(1);
  });

  it('erreur : Rai alerte, « Réessayer » relance le même scan', async () => {
    const env = await openPro();
    await scan(env, { code: 'UPSTREAM_UNAVAILABLE', message: 'x' }, { status: 503, statusText: 'Unavailable' });
    expect(query(env.harness, '[role="alert"] img')?.getAttribute('src')).toContain('rai-alerte.svg');
    button(env.harness, 'Réessayer')?.click();
    const retry = await expectRequest(env.ctrl, SCANS);
    expect(retry.request.body).toEqual({ address: WALLET });
    retry.flush(fakeWalletScanResponse());
    await stable(env.harness);
    expect(queryAll(env.harness, 'rj-wallet-token-card')).toHaveLength(5);
  });

  it('erreurs métier : token collé, wallet trop volumineux, quota épuisé (Scanner désactivé)', async () => {
    const env = await openPro();
    await scan(env, { code: 'WALLET_IS_TOKEN', message: 'x' }, { status: 422, statusText: 'Unprocessable' });
    expect(query(env.harness, '[data-error="WALLET_IS_TOKEN"] a')?.getAttribute('href')).toBe(`/analyse/${WALLET}`);

    await scan(env, { code: 'WALLET_TOO_LARGE', message: 'x' }, { status: 422, statusText: 'Unprocessable' });
    expect(root(env.harness).textContent).toContain('Wallet trop volumineux');

    await scan(env, { code: 'WALLET_SCAN_QUOTA_EXCEEDED', message: 'x' }, { status: 429, statusText: 'Too Many' });
    expect(root(env.harness).textContent).toContain('Scans du jour utilisés');
    expect(button(env.harness, 'Scanner')?.disabled).toBe(true);
  });

  it('plan requis renvoyé par le POST (essai expiré entre-temps) : écran d’explication', async () => {
    const env = await openPro();
    await scan(env, { code: 'WALLET_SCAN_PLAN_REQUIRED', message: 'x' }, { status: 403, statusText: 'Forbidden' });
    await waitFor(() => query(env.harness, '[data-access="plan"]') !== null);
    expect(query(env.harness, 'input')).toBeNull();
  });
});
