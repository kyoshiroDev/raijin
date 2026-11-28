import { ANALYSIS_ERROR_MESSAGES } from '@raijin/shared-contracts';
import { ANALYSIS_INPUT_MAX_LENGTH } from '@raijin/shared-util';
import { FAKE_MINTS } from '@raijin/web-data-access';
import { query, root, settle, setupFeature } from '../testing/harness';
import { sanitizeMintQuery } from './mint-query';

vi.setConfig({ testTimeout: 30_000 });

describe('repli sans JS : /analyse?mint=', () => {
  async function open(url: string) {
    const setup = await setupFeature();
    await setup.harness.navigateByUrl(url);
    await settle();
    setup.harness.detectChanges();
    return setup;
  }

  it('adresse valide : /analyse/<mint> en remplaçant l’historique, attribution conservée', async () => {
    const { router } = await open(`/analyse?mint=${FAKE_MINTS.safe}&utm_source=landing&rj_lp=%2Fguides`);
    expect(router.url).toBe(`/analyse/${FAKE_MINTS.safe}?utm_source=landing&rj_lp=%2Fguides`);
    expect(router.lastSuccessfulNavigation()?.extras.replaceUrl).toBe(true);
  });

  it('lien DexScreener : adresse extraite', async () => {
    const link = encodeURIComponent(`https://dexscreener.com/solana/${FAKE_MINTS.warn}?maker=x`);
    const { router } = await open(`/analyse?mint=${link}`);
    expect(router.url).toBe(`/analyse/${FAKE_MINTS.warn}`);
  });

  it('saisie invalide : écran d’analyse, champ prérempli et message d’erreur', async () => {
    const { harness, router } = await open('/analyse?mint=pas-un-token');
    expect(router.url).toBe('/analyse?mint=pas-un-token');
    const input = query<HTMLInputElement>(harness, 'input[name="token"]');
    expect(input?.value).toBe('pas-un-token');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(root(harness).textContent).toContain(ANALYSIS_ERROR_MESSAGES.MINT_INVALID);
  });

  it('valeur hostile ou trop longue : jamais redirigée, recopiée nettoyée et bornée', async () => {
    const hostile = encodeURIComponent(`${FAKE_MINTS.safe} ${'x'.repeat(400)}\u0000<script>`);
    const { harness, router } = await open(`/analyse?mint=${hostile}`);
    expect(router.url.startsWith('/analyse?mint=')).toBe(true);
    const value = query<HTMLInputElement>(harness, 'input[name="token"]')?.value ?? '';
    expect(value.length).toBeLessThanOrEqual(ANALYSIS_INPUT_MAX_LENGTH);
    expect(value).not.toContain('\u0000');
    expect(query(harness, 'script')).toBeNull();
  });

  it('nettoyage de la saisie', () => {
    expect(sanitizeMintQuery(' abc\u0007def ')).toBe('abcdef');
    expect(sanitizeMintQuery(null)).toBe('');
    expect(sanitizeMintQuery('y'.repeat(1000))).toHaveLength(ANALYSIS_INPUT_MAX_LENGTH);
  });
});
