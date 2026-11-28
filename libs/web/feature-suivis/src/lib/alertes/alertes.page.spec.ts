import { FIXTURE_MINTS, fakeAlertId, fakeAlertPage, fakeAlerts, fakeWatchList } from '@raijin/web-data-access';
import { API, button, dialog, expectRequest, query, queryAll, root, setupFeature, stable, waitFor } from '../testing/harness';
import { filtersFromQuery, queryFromFilters } from './alertes.page';

vi.setConfig({ testTimeout: 30_000 });

const isList = (r: { url: string; method: string }) => r.method === 'GET' && r.url === `${API}/alerts`;

async function open(url = '/alertes', page = fakeAlertPage()) {
  const env = await setupFeature();
  void env.harness.navigateByUrl(url);
  (await expectRequest(env.ctrl, `${API}/watches`)).flush(fakeWatchList());
  const req = await expectRequest(env.ctrl, isList);
  req.flush(page);
  await waitFor(() => query(env.harness, 'rj-alert-item, rj-empty-state') !== null);
  await stable(env.harness);
  return { ...env, req };
}

describe('filtres dans l’URL', () => {
  it('valeurs inconnues ignorées, ordre stable des types', () => {
    expect(filtersFromQuery('non-lues', 'holder_sold,moon,lp_removed', FIXTURE_MINTS.bonk)).toEqual({
      status: 'unread',
      types: ['lp_removed', 'holder_sold'],
      mint: FIXTURE_MINTS.bonk,
    });
    expect(filtersFromQuery('__proto__', undefined, 'pas-une-adresse')).toEqual({ status: 'all', types: [], mint: null });
    expect(queryFromFilters({ status: 'read', types: [], mint: null })).toEqual({ statut: 'lues', type: null, mint: null, alerte: null });
  });
});

describe('AlertesPage', () => {
  afterEach(() => document.querySelectorAll('[role="dialog"]').forEach((el) => el.remove()));

  it('historique : gravité icône + mot, phrase factuelle, non lue écrite en toutes lettres', async () => {
    const { harness } = await open();
    const items = queryAll(harness, 'rj-alert-item');
    expect(items).toHaveLength(5);
    const first = items[0] as HTMLElement;
    expect(first.querySelector('rj-verdict-badge')?.textContent).toContain('Danger');
    expect(first.querySelector('h3')?.textContent).toContain('Liquidité retirée');
    expect(first.textContent).toContain('42,5');
    expect(first.querySelector('[data-unread-label]')?.textContent).toContain('Non lue');
    expect(query(harness, '[data-unread-count]')?.textContent).toContain('3 alertes non lues');
    expect(root(harness).textContent).toContain('30 derniers jours');
  });

  it('« Charger plus » : curseur renvoyé tel quel, nouvelles alertes ajoutées', async () => {
    const [a, b] = fakeAlerts();
    if (!a || !b) throw new Error('fixtures');
    const { harness, ctrl } = await open('/alertes', fakeAlertPage([a], 'curseur-2'));
    button(harness, 'Charger plus')?.click();
    const next = await expectRequest(ctrl, isList);
    expect(next.request.params.get('cursor')).toBe('curseur-2');
    next.flush(fakeAlertPage([b], null));
    await stable(harness);
    expect(queryAll(harness, 'rj-alert-item')).toHaveLength(2);
    expect(query(harness, '[data-end]')?.textContent).toContain('Tu as tout vu');
  });

  it('filtres depuis l’URL (lien d’un suivi) : status, types, mint transmis à l’API', async () => {
    const { req } = await open(`/alertes?statut=non-lues&type=lp_removed&mint=${FIXTURE_MINTS.bonk}`);
    expect(req.request.params.get('status')).toBe('unread');
    expect(req.request.params.get('types')).toBe('lp_removed');
    expect(req.request.params.get('mint')).toBe(FIXTURE_MINTS.bonk);
  });

  it('mobile : « Filtres » ouvre une bottom sheet ; changer l’état recharge la liste', async () => {
    const { harness, ctrl, router } = await open();
    button(harness, 'Filtres')?.click();
    await stable(harness);
    const sheet = dialog() as HTMLElement;
    expect(sheet.querySelector('h2')?.textContent).toBe('Filtres');
    const unread = Array.from(sheet.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.value === 'unread');
    unread?.dispatchEvent(new Event('change'));
    await waitFor(() => router.url.includes('statut=non-lues'));
    const req = await expectRequest(ctrl, isList);
    expect(req.request.params.get('status')).toBe('unread');
    req.flush(fakeAlertPage([], null, 0));
    await stable(harness);
  });

  it('marquer lue puis « Tout marquer comme lu »', async () => {
    const { harness, ctrl } = await open();
    (query(harness, 'rj-alert-item button[aria-label^="Marquer lue"]') as HTMLButtonElement).click();
    const read = await expectRequest(ctrl, `${API}/alerts/read`);
    expect(read.request.body).toEqual({ ids: [fakeAlertId(1)], read: true });
    read.flush({ unread: 2 });
    await stable(harness);
    expect(query(harness, '[data-unread-count]')?.textContent).toContain('2 alertes non lues');
    button(harness, 'Tout marquer comme lu')?.click();
    const all = await expectRequest(ctrl, `${API}/alerts/read`);
    expect(all.request.body).toEqual({ all: true, read: true });
    all.flush({ unread: 0 });
    await stable(harness);
    expect(queryAll(harness, '[data-unread-label]')).toHaveLength(0);
    expect(button(harness, 'Tout marquer comme lu')?.disabled).toBe(true);
  });

  it('ouverture depuis une notification (?alerte=) : alerte mise en évidence et marquée lue', async () => {
    const { harness, ctrl } = await open(`/alertes?alerte=${fakeAlertId(2)}`);
    const read = await expectRequest(ctrl, `${API}/alerts/read`);
    expect(read.request.body).toEqual({ ids: [fakeAlertId(2)], read: true });
    read.flush({ unread: 2 });
    await stable(harness);
    expect(queryAll(harness, 'rj-alert-item article.bg-surface-raised')).toHaveLength(1);
  });

  it('vide : Rai bravo ; avec filtres : « Réinitialiser les filtres »', async () => {
    const empty = await open('/alertes', fakeAlertPage([], null, 0));
    expect(query(empty.harness, 'rj-empty-state img')?.getAttribute('src')).toContain('rai-bravo.svg');
    expect(root(empty.harness).textContent).toContain('Aucune alerte pour l’instant');
  });

  it('visiteur : connexion avec retour ; e-mail non confirmé : écran accessible sans requête de suivis', async () => {
    const anon = await setupFeature('anonymous');
    await anon.harness.navigateByUrl('/alertes');
    await waitFor(() => anon.router.url.startsWith('/compte/connexion'));
    expect(anon.router.url).toBe('/compte/connexion?redirect=%2Falertes');
  });

  it('e-mail non confirmé : alertes lues sans charger les suivis', async () => {
    const { harness, ctrl } = await setupFeature('authenticated', { emailVerified: false });
    void harness.navigateByUrl('/alertes');
    (await expectRequest(ctrl, isList)).flush(fakeAlertPage([], null, 0));
    await stable(harness);
    ctrl.expectNone(`${API}/watches`);
    expect(root(harness).textContent).toContain('Aucune alerte');
  });

  it('erreur : Rai alerte', async () => {
    const { harness, ctrl } = await setupFeature();
    void harness.navigateByUrl('/alertes');
    (await expectRequest(ctrl, `${API}/watches`)).flush(fakeWatchList());
    (await expectRequest(ctrl, isList)).flush({ code: 'INTERNAL_ERROR', message: 'x' }, { status: 500, statusText: 'Error' });
    await waitFor(() => query(harness, 'rj-error-state') !== null);
    await stable(harness);
    expect(query(harness, '[role="alert"] img')?.getAttribute('src')).toContain('rai-alerte.svg');
  });
});
