import { WALLET_REVOKE_GUIDES, type WalletRevokeGuide } from '@raijin/shared-contracts';
import { fakeWalletQuota } from '@raijin/web-data-access';
import { assessmentStatus, coverageText, formatAmount, formatExactUi, formatUsd, tokenLabel } from './format';
import { revokeGuideGroups } from './wallet-delegations';
import { readWalletInput, walletQuotaText } from './wallet.page';

const NBSP = ' ';
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

describe('format du scan de wallet', () => {
  it('montant exact sans perte de précision, compact à l’écran, illimité pour le u64 maximal', () => {
    expect(formatExactUi('1234567.891')).toBe(`1${NBSP}234${NBSP}567,891`);
    expect(formatExactUi('0.5')).toBe('0,5');
    const big = formatAmount({ raw: '123456789000', decimals: 5, ui: '1234567.89' }, 'BONK');
    expect(big.short).toBe(`1,2${NBSP}M${NBSP}BONK`);
    expect(big.exact).toBe(`1${NBSP}234${NBSP}567,89${NBSP}BONK`);
    expect(formatAmount({ raw: '5', decimals: 6, ui: '0.000005' }).short).toBe(`<${NBSP}0,1`);
    const max = formatAmount({ raw: '18446744073709551615', decimals: 6, ui: '18446744073709.551615' });
    expect(max.unlimited).toBe(true);
    expect(max.short).toBe('Illimité');
  });

  it('valeur indicative : inconnue, très faible, compacte', () => {
    expect(formatUsd(null)).toEqual({ short: 'Inconnue', exact: null });
    expect(formatUsd(0.004).short).toBe(`<${NBSP}0,01${NBSP}$`);
    expect(formatUsd(3856.4).short).toBe(`≈${NBSP}3,9${NBSP}k$`);
  });

  it('profondeur du verdict et statuts sans verdict', () => {
    const base = { status: 'analyzed', verdict: 'safe', explanation: 'x', degraded: false, analyzedAt: '2026-11-22T10:00:00.000Z', fromCache: false } as const;
    expect(coverageText({ ...base, coverage: 'light', checksEvaluated: 6 })).toBe('Contrôle rapide (6/9)');
    expect(coverageText({ ...base, coverage: 'full', checksEvaluated: 9 })).toBe('Analyse complète (9/9)');
    expect(assessmentStatus({ status: 'not_analyzed', reason: 'over_limit' }, 20).text).toContain('20 tokens');
    expect(assessmentStatus({ status: 'not_analyzed', reason: 'dust' }, 20).label).toBe('Non analysé');
    expect(assessmentStatus({ status: 'unavailable', reason: 'budget' }, 20).label).toBe('Indisponible');
    expect(tokenLabel(null, WALLET)).toBe('9WzD…AWWM');
  });

  it('saisie : wallet, mint et programme connus, phrase de récupération, adresse invalide', () => {
    expect(readWalletInput(`  ${WALLET} `)).toEqual({ kind: 'valid', address: WALLET });
    expect(readWalletInput('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').kind).toBe('mint');
    expect(readWalletInput('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').kind).toBe('program');
    expect(readWalletInput('abandon '.repeat(12)).kind).toBe('seed');
    expect(readWalletInput('0OIl-pas-une-adresse').kind).toBe('invalid');
    expect(readWalletInput('   ').kind).toBe('empty');
  });

  it('quota du jour', () => {
    expect(walletQuotaText(fakeWalletQuota({ remaining: 19 }))).toBe(`Il te reste 19${NBSP}scans sur 20 aujourd’hui.`);
    expect(walletQuotaText(fakeWalletQuota({ remaining: 0 }))).toContain('minuit');
    expect(walletQuotaText(null)).toBe('');
  });

  it('guides de révocation : uniquement les URLs exactes de la liste blanche, groupées par wallet', () => {
    const groups = revokeGuideGroups();
    expect(groups.map((g) => g.walletName)).toEqual(['Phantom', 'Solflare']);
    expect(groups.flatMap((g) => g.guides).length).toBe(WALLET_REVOKE_GUIDES.length);
    const forged: WalletRevokeGuide = { ...WALLET_REVOKE_GUIDES[0], url: 'https://help.phantom.com.evil.example/revoke' } as WalletRevokeGuide;
    expect(revokeGuideGroups([forged])).toEqual([]);
  });
});
