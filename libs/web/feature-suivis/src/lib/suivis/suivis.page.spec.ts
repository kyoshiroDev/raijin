import { FIXTURE_MINTS, fakeWatch, fakeWatchId, fakeWatchList } from '@raijin/web-data-access';
import { API, button, dialog, expectRequest, query, queryAll, root, setupFeature, stable, waitFor } from '../testing/harness';

vi.setConfig({ testTimeout: 30_000 });

const WATCHES = `${API}/watches`;

async function open(list = fakeWatchList()) {
  const env = await setupFeature();
  void env.harness.navigateByUrl('/suivis');
  (await expectRequest(env.ctrl, WATCHES)).flush(list);
  await waitFor(() => query(env.harness, '[data-plan-limit]') !== null || query(env.harness, 'rj-error-state') !== null);
  await stable(env.harness);
  return env;
}

describe('SuivisPage', () => {
  afterEach(() => document.querySelectorAll('[role="dialog"]').forEach((el) => el.remove()));

  it('visiteur : renvoyé vers la connexion avec retour sur /suivis', async () => {
    const { harness, router } = await setupFeature('anonymous');
    await harness.navigateByUrl('/suivis');
    await waitFor(() => router.url.startsWith('/compte/connexion'));
    expect(router.url).toBe('/compte/connexion?redirect=%2Fsuivis');
  });

  it('chargement : skeleton (aria-busy) sans mascotte', async () => {
    const { harness, ctrl } = await setupFeature();
    void harness.navigateByUrl('/suivis');
    const req = await expectRequest(ctrl, WATCHES);
    await stable(harness);
    expect(query(harness, '[aria-busy="true"]')?.getAttribute('aria-label')).toBe('Chargement des suivis');
    expect(query(harness, 'rj-mascot')).toBeNull();
    req.flush(fakeWatchList([]));
  });

  it('vide : Rai bravo, compteur 0 / 3, une seule action jaune « Analyser un token »', async () => {
    const { harness } = await open(fakeWatchList([]));
    expect(query(harness, 'rj-empty-state img')?.getAttribute('src')).toContain('rai-bravo.svg');
    expect(query(harness, '[data-watch-count]')?.textContent?.trim()).toBe('0 / 3');
    expect(root(harness).textContent).toContain('plan Gratuit');
    const primaries = queryAll(harness, '.bg-thunder');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent).toContain('Analyser un token');
  });

  it('erreur : Rai alerte et « Réessayer » relance la requête', async () => {
    const { harness, ctrl } = await setupFeature();
    void harness.navigateByUrl('/suivis');
    (await expectRequest(ctrl, WATCHES)).flush({ code: 'INTERNAL_ERROR', message: 'x' }, { status: 500, statusText: 'Error' });
    await waitFor(() => query(harness, 'rj-error-state') !== null);
    await stable(harness);
    expect(query(harness, '[role="alert"] img')?.getAttribute('src')).toContain('rai-alerte.svg');
    button(harness, 'Réessayer')?.click();
    (await expectRequest(ctrl, WATCHES)).flush(fakeWatchList([]));
    await stable(harness);
  });

  it('rempli : verdict icône + mot, mint tronqué au milieu, dernière vérification, non lues, suivi en pause expliqué', async () => {
    const paused = fakeWatch({ id: fakeWatchId(2), mint: FIXTURE_MINTS.usdc, token: null, status: 'paused', pausedReason: 'plan_limit', lastVerdict: 'danger', unreadAlerts: 2 });
    const { harness } = await open(fakeWatchList([fakeWatch({ lastCheckedAt: new Date(Date.now() - 5 * 60_000).toISOString() }), paused]));
    const cards = queryAll(harness, 'rj-watch-card');
    expect(cards).toHaveLength(2);
    const first = cards[0] as HTMLElement;
    expect(first.querySelector('rj-verdict-badge')?.textContent).toContain('Sain');
    expect(first.querySelector('rj-verdict-badge rj-icon')).not.toBeNull();
    expect(first.querySelector('rj-address-chip')?.textContent).toContain('DezX…B263');
    expect(first.textContent).toContain('Vérifié il y a 5');
    const second = cards[1] as HTMLElement;
    expect(second.querySelector('[data-watch-name]')?.textContent).toContain('Nom non publié');
    expect(second.querySelector('rj-address-chip')?.textContent).toContain('EPjF…Dt1v');
    expect(second.querySelector('[data-paused]')?.textContent).toContain('limite de ton plan');
    expect(second.textContent).toContain('2 alertes non lues');
    expect(query(harness, '[data-plan-paused]')?.textContent).toContain('1 suivi est en pause');
    expect(query(harness, '[data-watch-count]')?.textContent?.trim()).toBe('1 / 3');
  });

  it('pause : PATCH { status: paused } ; reprise refusée au-delà de la limite : bottom sheet', async () => {
    const watch = fakeWatch();
    const { harness, ctrl } = await open(fakeWatchList([watch]));
    (query(harness, 'rj-watch-card button[aria-label^="Mettre en pause"]') as HTMLButtonElement).click();
    const patch = await expectRequest(ctrl, `${WATCHES}/${watch.id}`);
    expect(patch.request.body).toEqual({ status: 'paused' });
    patch.flush({ ...watch, status: 'paused', pausedReason: 'user' });
    await stable(harness);
    (query(harness, 'rj-watch-card button[aria-label^="Reprendre"]') as HTMLButtonElement).click();
    (await expectRequest(ctrl, `${WATCHES}/${watch.id}`)).flush({ code: 'WATCH_LIMIT_REACHED', message: 'x' }, { status: 403, statusText: 'Forbidden' });
    await stable(harness);
    expect(dialog()?.textContent).toContain('Limite de suivis atteinte');
  });

  it('retrait avec confirmation : DELETE puis carte retirée', async () => {
    const watch = fakeWatch();
    const { harness, ctrl } = await open(fakeWatchList([watch]));
    (query(harness, 'rj-watch-card button[aria-label^="Retirer"]') as HTMLButtonElement).click();
    await stable(harness);
    expect(dialog()?.textContent).toContain('Bonk');
    const confirm = Array.from(dialog()?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('Retirer le suivi'));
    confirm?.click();
    const req = await expectRequest(ctrl, (r) => r.method === 'DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await stable(harness);
    expect(queryAll(harness, 'rj-watch-card')).toHaveLength(0);
    expect(query(harness, 'rj-empty-state')).not.toBeNull();
  });

  it('limite atteinte : compteur et message factuel, sans urgence', async () => {
    const items = [1, 2, 3].map((n) => fakeWatch({ id: fakeWatchId(n), mint: [FIXTURE_MINTS.bonk, FIXTURE_MINTS.usdc, FIXTURE_MINTS.jup][n - 1] }));
    const { harness } = await open(fakeWatchList(items));
    const banner = query(harness, '[data-plan-limit]')?.textContent ?? '';
    expect(banner).toContain('3 / 3');
    expect(banner).toContain('Limite atteinte');
    expect(banner).not.toMatch(/vite|dernière chance|dépêche/i);
  });
});
