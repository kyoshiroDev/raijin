import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  adminAcquisitionSchema,
  adminHealthSchema,
  adminOverviewSchema,
  adminProductSchema,
  adminRevenueSchema,
  adminSeoSchema,
  adminTrafficSchema,
  adminTrialsSchema,
  adminUserDetailSchema,
  adminUserPageSchema,
} from '@raijin/shared-contracts';
import { loadContracts } from '../contracts';
import { AdminApi } from './admin-api';
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
} from './admin-fixtures';
import { AdminReport } from './admin-report';

const API = '/api/v1';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Fixtures admin', () => {
  it('conformes aux contrats', () => {
    expect(adminOverviewSchema.safeParse(ADMIN_OVERVIEW_FIXTURE).success).toBe(true);
    expect(adminTrafficSchema.safeParse(ADMIN_TRAFFIC_FIXTURE).success).toBe(true);
    expect(adminSeoSchema.safeParse(ADMIN_SEO_FIXTURE).success).toBe(true);
    expect(adminAcquisitionSchema.safeParse(ADMIN_ACQUISITION_FIXTURE).success).toBe(true);
    expect(adminRevenueSchema.safeParse(ADMIN_REVENUE_FIXTURE).success).toBe(true);
    expect(adminTrialsSchema.safeParse(ADMIN_TRIALS_FIXTURE).success).toBe(true);
    expect(adminProductSchema.safeParse(ADMIN_PRODUCT_FIXTURE).success).toBe(true);
    expect(adminHealthSchema.safeParse(ADMIN_HEALTH_FIXTURE).success).toBe(true);
    expect(adminUserPageSchema.safeParse(ADMIN_USER_PAGE_FIXTURE).success).toBe(true);
    expect(adminUserDetailSchema.safeParse(ADMIN_USER_DETAIL_FIXTURE).success).toBe(true);
  });
});

describe('AdminApi', () => {
  async function setup() {
    await loadContracts();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return { api: TestBed.inject(AdminApi), http: TestBed.inject(HttpTestingController) };
  }

  it('écrans : chemins, paramètres de période (vides ignorés), réponses validées', async () => {
    const { api, http } = await setup();
    const overview = api.overview({ period: '30d' });
    await settle();
    http.expectOne(`${API}/admin/overview?period=30d`).flush(ADMIN_OVERVIEW_FIXTURE);
    expect((await overview).kpis).toHaveLength(10);

    const acquisition = api.acquisition({ from: '2026-11-01', to: '2026-11-21' }, 'campaign');
    await settle();
    http.expectOne(`${API}/admin/acquisition?from=2026-11-01&to=2026-11-21&dimension=campaign`).flush({ ...ADMIN_ACQUISITION_FIXTURE, dimension: 'campaign' });
    await acquisition;

    const seo = api.seo('90d');
    await settle();
    http.expectOne(`${API}/admin/seo?window=90d`).flush(ADMIN_SEO_FIXTURE);
    await seo;

    const users = api.users({ q: 'alice', plan: undefined, limit: 20 });
    await settle();
    http.expectOne(`${API}/admin/users?q=alice&limit=20`).flush(ADMIN_USER_PAGE_FIXTURE);
    expect((await users).total).toBe(2);
    http.verify();
  });

  it('réponse hors contrat refusée (texte avec caractère de contrôle)', async () => {
    const { api, http } = await setup();
    const traffic = api.traffic({ period: '7d' });
    await settle();
    const hostile = structuredClone(ADMIN_TRAFFIC_FIXTURE);
    if (hostile.data) hostile.data.topPages[0] = { path: '/\u0000', title: null, views: 1, users: 1 };
    http.expectOne(`${API}/admin/traffic?period=7d`).flush(hostile);
    await expect(traffic).rejects.toBeTruthy();
  });

  it('action utilisateur : POST du corps, résultat validé', async () => {
    const { api, http } = await setup();
    const result = api.userAction(ADMIN_USER_DETAIL_FIXTURE.id, { type: 'grant_pro_month', reason: 'geste commercial' });
    await settle();
    const req = http.expectOne(`${API}/admin/users/${ADMIN_USER_DETAIL_FIXTURE.id}/actions`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ type: 'grant_pro_month', reason: 'geste commercial' });
    req.flush({ type: 'grant_pro_month', auditLogId: '0196f2a1-7c3e-7b2a-9c1d-2e3f4a5b6c99', user: ADMIN_USER_DETAIL_FIXTURE });
    expect((await result).user?.email).toBe('alice@exemple.fr');
  });
});

describe('AdminReport', () => {
  it('seule la dernière requête compte ; erreur conservée ; reset efface tout', async () => {
    const report = new AdminReport<number>();
    let resolveSlow: (value: number) => void = () => undefined;
    const slow = report.load(() => new Promise<number>((resolve) => (resolveSlow = resolve)));
    await report.load(async () => 2);
    resolveSlow(1);
    await slow;
    expect(report.data()).toBe(2);
    expect(report.status()).toBe('ready');
    await report.load(async () => {
      throw new Error('réseau');
    });
    expect(report.status()).toBe('error');
    expect(report.data()).toBe(2);
    report.reset();
    expect(report.data()).toBeNull();
    expect(report.status()).toBe('idle');
  });
});
