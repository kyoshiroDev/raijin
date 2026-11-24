import { TestBed } from '@angular/core/testing';
import {
  ADMIN_ACQUISITION_FIXTURE,
  ADMIN_HEALTH_FIXTURE,
  ADMIN_OVERVIEW_FIXTURE,
  ADMIN_PRODUCT_FIXTURE,
  ADMIN_REVENUE_FIXTURE,
  ADMIN_SEO_FIXTURE,
  ADMIN_TRAFFIC_FIXTURE,
  ADMIN_TRIALS_FIXTURE,
  ADMIN_USER_DETAIL_FIXTURE,
  ADMIN_USER_PAGE_FIXTURE,
  AdminSessionStore,
  fakeAdminSecurityStatus,
} from '@raijin/web-data-access';
import { API, STATUS, flush, navigate, settle, setupAdmin, text } from '../testing/harness';

afterEach(() => TestBed.inject(AdminSessionStore).clear());

/** Ouvre un écran avec une session admin vérifiée et renvoie le harnais (requête de l'écran en attente). */
async function open(url: string) {
  const kit = await setupAdmin();
  const done = navigate(kit.router, url);
  await settle();
  kit.ctrl.expectOne(STATUS).flush(fakeAdminSecurityStatus());
  await done;
  await flush(kit.harness);
  return kit;
}

function root(kit: Awaited<ReturnType<typeof open>>): HTMLElement {
  return kit.harness.routeNativeElement as HTMLElement;
}

describe('Écrans statistiques de l’admin', () => {
  it('vue d’ensemble : 10 KPI en grille, entonnoir de 6 étapes, données simulées signalées', async () => {
    const kit = await open('/admin');
    kit.ctrl.expectOne(`${API}/admin/overview?period=7d`).flush(ADMIN_OVERVIEW_FIXTURE);
    await flush(kit.harness);
    expect(root(kit).querySelectorAll('rj-kpi-card')).toHaveLength(10);
    const page = text(kit.harness);
    expect(page).toContain('Visiteurs de la landing');
    expect(page).toContain('Churn');
    expect(page).toContain('6. Pro');
    expect(page).toContain('Données simulées');
    expect(page).toContain('Agrégats calculés jusqu’au 21 novembre 2026');
  }, 30_000);

  it('changement de période : nouvelle requête', async () => {
    const kit = await open('/admin');
    kit.ctrl.expectOne(`${API}/admin/overview?period=7d`).flush(ADMIN_OVERVIEW_FIXTURE);
    await flush(kit.harness);
    const radio = root(kit).querySelector<HTMLInputElement>('rj-period-select input[value="30d"]');
    radio?.dispatchEvent(new Event('change'));
    await flush(kit.harness);
    kit.ctrl.expectOne(`${API}/admin/overview?period=30d`).flush({ ...ADMIN_OVERVIEW_FIXTURE, range: { ...ADMIN_OVERVIEW_FIXTURE.range, period: '30d' } });
    await flush(kit.harness);
  });

  it('erreur de chargement : état d’erreur avec « Réessayer »', async () => {
    const kit = await open('/admin');
    kit.ctrl.expectOne(`${API}/admin/overview?period=7d`).flush({ code: 'INTERNAL_ERROR', message: 'x' }, { status: 500, statusText: 'Erreur' });
    await flush(kit.harness);
    expect(text(kit.harness)).toContain('Impossible de charger cet écran');
    root(kit).querySelector<HTMLButtonElement>('rj-error-state button')?.click();
    await flush(kit.harness);
    kit.ctrl.expectOne(`${API}/admin/overview?period=7d`).flush(ADMIN_OVERVIEW_FIXTURE);
    await flush(kit.harness);
    expect(root(kit).querySelectorAll('rj-kpi-card')).toHaveLength(10);
  });

  it('trafic : GA4 non connecté → « Non connecté » et renvoi vers docs/DEPLOY.md, aucune donnée', async () => {
    const kit = await open('/admin/trafic');
    kit.ctrl.expectOne(`${API}/admin/traffic?period=30d`).flush({ range: ADMIN_TRAFFIC_FIXTURE.range, service: { status: 'not_connected' }, data: null });
    await flush(kit.harness);
    const page = text(kit.harness);
    expect(page).toContain('Google Analytics 4 : Non connecté');
    expect(page).toContain('docs/DEPLOY.md');
    expect(root(kit).querySelectorAll('rj-kpi-card')).toHaveLength(0);
  });

  it('trafic connecté : textes hostiles affichés en texte, jamais interprétés', async () => {
    const kit = await open('/admin/trafic');
    kit.ctrl.expectOne(`${API}/admin/traffic?period=30d`).flush(ADMIN_TRAFFIC_FIXTURE);
    await flush(kit.harness);
    expect(text(kit.harness)).toContain('<img src=x onerror=alert(1)>');
    expect(root(kit).querySelector('img[src="x"]')).toBeNull();
    expect(root(kit).querySelectorAll('rj-kpi-card')).toHaveLength(6);
  });

  it('SEO : décalage Search Console affiché, opportunités 5–20', async () => {
    const kit = await open('/admin/seo');
    kit.ctrl.expectOne(`${API}/admin/seo?window=28d`).flush(ADMIN_SEO_FIXTURE);
    await flush(kit.harness);
    const page = text(kit.harness);
    expect(page).toContain('Données arrêtées au 19 novembre 2026');
    expect(page).toContain('3 jours de décalage');
    expect(page).toContain('Requêtes à faire progresser');
    expect(page).toContain('mint authority solana');
  });

  it('acquisition : valeur absente = direct, changement de dimension', async () => {
    const kit = await open('/admin/acquisition');
    kit.ctrl.expectOne(`${API}/admin/acquisition?period=30d&dimension=source`).flush(ADMIN_ACQUISITION_FIXTURE);
    await flush(kit.harness);
    expect(text(kit.harness)).toContain('(direct ou inconnu)');
    // Sous 1024 px, les filtres sont dans un bottom sheet.
    [...root(kit).querySelectorAll('button')].find((button) => button.textContent?.includes('Filtres'))?.click();
    await flush(kit.harness);
    const select = document.querySelector<HTMLSelectElement>('select');
    expect(select).not.toBeNull();
    if (select) {
      select.value = 'campaign';
      select.dispatchEvent(new Event('change'));
    }
    await flush(kit.harness);
    kit.ctrl.expectOne(`${API}/admin/acquisition?period=30d&dimension=campaign`).flush({ ...ADMIN_ACQUISITION_FIXTURE, dimension: 'campaign' });
    await flush(kit.harness);
  });

  it('revenus : mode simulation signalé', async () => {
    const kit = await open('/admin/revenus');
    kit.ctrl.expectOne(`${API}/admin/revenue?period=30d`).flush(ADMIN_REVENUE_FIXTURE);
    await flush(kit.harness);
    expect(text(kit.harness)).toContain('Paiement en mode simulation');
  });

  it('essais : cohortes, refus de l’anti-abus, raisons de non-conversion vides', async () => {
    const kit = await open('/admin/essais');
    kit.ctrl.expectOne(`${API}/admin/trials`).flush(ADMIN_TRIALS_FIXTURE);
    await flush(kit.harness);
    const page = text(kit.harness);
    expect(page).toContain('Adresse jetable');
    expect(page).toContain('Aucune raison collectée');
  });

  it('produit : verdicts nommés et sources', async () => {
    const kit = await open('/admin/produit');
    kit.ctrl.expectOne(`${API}/admin/product?period=30d`).flush(ADMIN_PRODUCT_FIXTURE);
    await flush(kit.harness);
    const page = text(kit.harness);
    expect(page).toContain('RugCheck');
    expect(page).toContain('BONK');
  });

  it('santé : alerte ouverte, quotas, services configurés ou non', async () => {
    const kit = await open('/admin/sante');
    kit.ctrl.expectOne(`${API}/admin/health`).flush(ADMIN_HEALTH_FIXTURE);
    await flush(kit.harness);
    const page = text(kit.harness);
    expect(page).toContain('Job en échec répété : Purge quotidienne');
    expect(page).toContain('Au-delà de 80 %');
    expect(page).toContain('Non configuré');
    expect(root(kit).querySelector('[role="progressbar"]')).not.toBeNull();
    // Taux d'erreur reconstitué : « estimé » visible et expliqué ; prochaine exécution inconnue : « — » expliqué.
    expect(page).toContain('Taux d’erreur 5xx (estimé)');
    expect(root(kit).querySelector('[data-testid="api-estimated-note"]')).not.toBeNull();
    expect(page).toContain('Prochaine exécution');
    expect(root(kit).querySelector('[data-testid="next-run-note"]')).not.toBeNull();
  });

  it('santé : fenêtre exacte et jobs planifiés → ni « estimé » ni note', async () => {
    const kit = await open('/admin/sante');
    const jobs = ADMIN_HEALTH_FIXTURE.jobs.map((job) => ({ ...job, nextRunAt: '2026-11-23T02:15:00.000Z' }));
    kit.ctrl.expectOne(`${API}/admin/health`).flush({ ...ADMIN_HEALTH_FIXTURE, jobs, api: { ...ADMIN_HEALTH_FIXTURE.api, estimated: false } });
    await flush(kit.harness);
    const page = text(kit.harness);
    expect(page).not.toContain('(estimé)');
    expect(root(kit).querySelector('[data-testid="api-estimated-note"]')).toBeNull();
    expect(root(kit).querySelector('[data-testid="next-run-note"]')).toBeNull();
    expect(page).toContain('23/11/2026');
  });

  it('vue d’ensemble : étape au-delà de la précédente plafonnée à 100 % et expliquée', async () => {
    const kit = await open('/admin');
    const funnel = ADMIN_OVERVIEW_FIXTURE.funnel.map((step) =>
      step.key === 'demo_analyses' ? { ...step, value: 2400, rateFromPrevious: 1, exceedsPrevious: true } : step,
    );
    kit.ctrl.expectOne(`${API}/admin/overview?period=7d`).flush({ ...ADMIN_OVERVIEW_FIXTURE, funnel });
    await flush(kit.harness);
    const page = text(kit.harness);
    expect(page).toContain('(plafonné)');
    const rates = [...root(kit).querySelectorAll('ol li span.text-label span.tabular')].map((rate) => Number((rate.textContent ?? '').replace(/[^\d,]/g, '').replace(',', '.')));
    expect(rates.length).toBeGreaterThan(0);
    expect(Math.max(...rates)).toBeLessThanOrEqual(100);
    expect(root(kit).querySelector('[data-testid="funnel-cap-note"]')).not.toBeNull();
  });
});

describe('Utilisateurs', () => {
  it('liste, fiche en panneau, action destructive confirmée par l’e-mail recopié', async () => {
    const kit = await open('/admin/utilisateurs');
    kit.ctrl.expectOne(`${API}/admin/users`).flush(ADMIN_USER_PAGE_FIXTURE);
    await flush(kit.harness);
    expect(text(kit.harness)).toContain('alice@exemple.fr');

    await kit.router.navigateByUrl(`/admin/utilisateurs?fiche=${ADMIN_USER_DETAIL_FIXTURE.id}`);
    await flush(kit.harness);
    kit.ctrl.expectOne(`${API}/admin/users/${ADMIN_USER_DETAIL_FIXTURE.id}`).flush(ADMIN_USER_DETAIL_FIXTURE);
    await flush(kit.harness);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Suspendre le compte');

    [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Suspendre le compte'))?.click();
    await flush(kit.harness);
    const sheet = [...document.querySelectorAll('[role="dialog"]')].at(-1) as HTMLElement;
    const confirm = [...sheet.querySelectorAll('button')].find((button) => button.textContent?.includes('Confirmer')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const textarea = sheet.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'abus constaté';
    textarea.dispatchEvent(new Event('input'));
    const email = sheet.querySelector('input[type="email"]') as HTMLInputElement;
    email.value = 'mauvais@exemple.fr';
    email.dispatchEvent(new Event('input'));
    await flush(kit.harness);
    expect(confirm.disabled).toBe(true);
    email.value = 'alice@exemple.fr';
    email.dispatchEvent(new Event('input'));
    await flush(kit.harness);
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await flush(kit.harness);
    const request = kit.ctrl.expectOne(`${API}/admin/users/${ADMIN_USER_DETAIL_FIXTURE.id}/actions`);
    expect(request.request.body).toEqual({ type: 'suspend', reason: 'abus constaté', confirmEmail: 'alice@exemple.fr' });
    request.flush({ type: 'suspend', auditLogId: '0196f2a1-7c3e-7b2a-9c1d-2e3f4a5b6c99', user: { ...ADMIN_USER_DETAIL_FIXTURE, status: 'suspended', suspendedAt: '2026-11-22T10:05:00.000Z' } });
    await flush(kit.harness);
    kit.ctrl.expectOne(`${API}/admin/users`).flush(ADMIN_USER_PAGE_FIXTURE);
    await flush(kit.harness);
    expect(document.body.textContent).toContain('Compte suspendu depuis le 22 novembre 2026');
  });

  it('fiche : lien Stripe en mode test signalé', async () => {
    const kit = await open(`/admin/utilisateurs?fiche=${ADMIN_USER_DETAIL_FIXTURE.id}`);
    kit.ctrl.expectOne(`${API}/admin/users`).flush(ADMIN_USER_PAGE_FIXTURE);
    await flush(kit.harness);
    kit.ctrl
      .expectOne(`${API}/admin/users/${ADMIN_USER_DETAIL_FIXTURE.id}`)
      .flush({ ...ADMIN_USER_DETAIL_FIXTURE, stripeDashboardUrl: 'https://dashboard.stripe.com/test/customers/cus_ABC123' });
    await flush(kit.harness);
    const link = document.querySelector<HTMLAnchorElement>('[role="dialog"] a[href^="https://dashboard.stripe.com/"]');
    expect(link?.textContent).toContain('dashboard Stripe (mode test)');
  });

  it('recherche : moins de 3 caractères refusée sans requête', async () => {
    const kit = await open('/admin/utilisateurs');
    kit.ctrl.expectOne(`${API}/admin/users`).flush(ADMIN_USER_PAGE_FIXTURE);
    await flush(kit.harness);
    const search = root(kit).querySelector('input[type="search"]') as HTMLInputElement;
    search.value = 'al';
    search.dispatchEvent(new Event('input'));
    root(kit).querySelector('form[role="search"]')?.dispatchEvent(new Event('submit'));
    await flush(kit.harness);
    expect(text(kit.harness)).toContain('Saisis au moins 3 caractères');
    kit.ctrl.expectNone(() => true);
  });
});
