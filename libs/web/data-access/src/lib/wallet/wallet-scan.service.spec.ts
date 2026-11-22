import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { walletScanQuotaResponseSchema, walletScanResponseSchema } from '@raijin/shared-contracts';
import { loadContracts } from '../contracts';
import {
  WALLET_FIXTURES,
  fakeWalletDelegation,
  fakeWalletQuotaResponse,
  fakeWalletScan,
  fakeWalletScanResponse,
  fakeWalletToken,
} from '../testing/wallet-fixtures';
import { WalletScanService } from './wallet-scan.service';

const API = '/api/v1';
const SCANS = `${API}/wallet-scans`;
const QUOTA = `${API}/wallet-scans/quota`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  await loadContracts();
  TestBed.configureTestingModule({ providers: [WalletScanService, provideHttpClient(), provideHttpClientTesting()] });
  return { service: TestBed.inject(WalletScanService), ctrl: TestBed.inject(HttpTestingController) };
}

describe('fixtures du scan de wallet', () => {
  it('conformes aux contrats (résultat varié, délégations, quota)', () => {
    expect(walletScanResponseSchema.safeParse(fakeWalletScanResponse()).success).toBe(true);
    expect(walletScanResponseSchema.safeParse(fakeWalletScanResponse(fakeWalletScan(undefined, [fakeWalletDelegation()]))).success).toBe(true);
    expect(walletScanResponseSchema.safeParse(fakeWalletScanResponse(fakeWalletScan([], []))).success).toBe(true);
    expect(walletScanQuotaResponseSchema.safeParse(fakeWalletQuotaResponse()).success).toBe(true);
    expect(walletScanQuotaResponseSchema.safeParse(fakeWalletQuotaResponse(false)).success).toBe(true);
  });
});

describe('WalletScanService', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('accès : Pro autorisé avec le quota du jour, Gratuit refusé, 401 déconnecté, panne en erreur', async () => {
    const { service, ctrl } = await setup();
    let pending = service.checkAccess();
    expect(service.access()).toBe('checking');
    ctrl.expectOne(QUOTA).flush(fakeWalletQuotaResponse(true, { remaining: 7 }));
    await pending;
    expect(service.access()).toBe('allowed');
    expect(service.quota()?.remaining).toBe(7);

    pending = service.checkAccess();
    ctrl.expectOne(QUOTA).flush(fakeWalletQuotaResponse(false));
    await pending;
    expect(service.access()).toBe('plan_required');

    pending = service.checkAccess();
    ctrl.expectOne(QUOTA).flush({ code: 'UNAUTHORIZED', message: 'x' }, { status: 401, statusText: 'Unauthorized' });
    await pending;
    expect(service.access()).toBe('signed_out');

    pending = service.checkAccess();
    ctrl.expectOne(QUOTA).flush({ code: 'INTERNAL_ERROR', message: 'x' }, { status: 500, statusText: 'Error' });
    await pending;
    expect(service.access()).toBe('error');
    expect(service.accessError()?.code).toBe('INTERNAL_ERROR');
  });

  it('scan : adresse dans le corps du POST, jamais dans l’URL ; résultat validé et quota mis à jour', async () => {
    const { service, ctrl } = await setup();
    const pending = service.scan(`  ${WALLET_FIXTURES.wallet} `);
    expect(service.loading()).toBe(true);
    await settle();
    const req = ctrl.expectOne(SCANS);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ address: WALLET_FIXTURES.wallet });
    expect(req.request.urlWithParams).toBe(SCANS);
    req.flush(fakeWalletScanResponse(undefined, { remaining: 3 }));
    expect(await pending).toBe(true);
    expect(service.status()).toBe('ready');
    expect(service.result()?.tokens).toHaveLength(5);
    expect(service.quota()?.remaining).toBe(3);
  });

  it('nom de token hostile nettoyé par le contrat (bidi, caractères invisibles)', async () => {
    const { service, ctrl } = await setup();
    const hostile = fakeWalletToken({
      token: { mint: WALLET_FIXTURES.mints.bonk, name: 'Bonk\u202e<img src=x onerror=alert(1)>', symbol: 'B\u200bONK', decimals: 5, tokenProgram: 'spl-token', untrusted: true },
    });
    const pending = service.scan(WALLET_FIXTURES.wallet);
    await settle();
    ctrl.expectOne(SCANS).flush(fakeWalletScanResponse(fakeWalletScan([hostile])));
    await pending;
    const token = service.result()?.tokens[0]?.token;
    expect(token?.name).not.toContain('\u202e');
    expect(token?.symbol).toBe('BONK');
  });

  it('adresse invalide ou mint connu : refus local sans requête', async () => {
    const { service } = await setup();
    expect(await service.scan('pas-une-adresse')).toBe(false);
    expect(service.error()?.code).toBe('WALLET_INVALID');
    expect(await service.scan(WALLET_FIXTURES.mints.usdc)).toBe(false);
    expect(service.error()?.code).toBe('WALLET_IS_TOKEN');
  });

  it('erreurs de l’API : plan requis, quota épuisé (compteur à 0), réponse non conforme', async () => {
    const { service, ctrl } = await setup();
    const access = service.checkAccess();
    ctrl.expectOne(QUOTA).flush(fakeWalletQuotaResponse(true, { remaining: 2 }));
    await access;

    let pending = service.scan(WALLET_FIXTURES.wallet);
    await settle();
    ctrl.expectOne(SCANS).flush({ code: 'WALLET_SCAN_QUOTA_EXCEEDED', message: 'x' }, { status: 429, statusText: 'Too Many' });
    await pending;
    expect(service.quotaExhausted()).toBe(true);
    expect(service.quota()?.remaining).toBe(0);

    pending = service.scan(WALLET_FIXTURES.wallet);
    await settle();
    ctrl.expectOne(SCANS).flush({ code: 'WALLET_SCAN_PLAN_REQUIRED', message: 'x' }, { status: 403, statusText: 'Forbidden' });
    await pending;
    expect(service.access()).toBe('plan_required');

    pending = service.scan(WALLET_FIXTURES.wallet);
    await settle();
    ctrl.expectOne(SCANS).flush({ scan: { address: 'x' }, quota: null });
    expect(await pending).toBe(false);
    expect(service.error()?.code).toBe('INTERNAL_ERROR');
  });

  it('une réponse dépassée par un scan plus récent est ignorée ; reset efface le résultat', async () => {
    const { service, ctrl } = await setup();
    const first = service.scan(WALLET_FIXTURES.wallet);
    await settle();
    const second = service.scan(WALLET_FIXTURES.otherWallet);
    await settle();
    const [a, b] = ctrl.match(SCANS);
    b?.flush(fakeWalletScanResponse(fakeWalletScan(undefined, [], { address: WALLET_FIXTURES.otherWallet })));
    a?.flush(fakeWalletScanResponse());
    expect(await second).toBe(true);
    expect(await first).toBe(false);
    expect(service.result()?.address).toBe(WALLET_FIXTURES.otherWallet);
    service.reset();
    expect(service.result()).toBeNull();
    expect(service.status()).toBe('idle');
  });
});
