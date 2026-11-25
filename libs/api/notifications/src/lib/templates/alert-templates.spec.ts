import { ALERT_TYPES } from '@raijin/shared-contracts';
import { alertDigestTemplate, digestIntro, RAI_ALERT_ALT, weeklyDigestTemplate } from './alert-templates';
import { describeAlert, type AlertMessage } from './alert-text';
import { LEGAL_NOTICE } from './layout';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ctx = { logoUrl: 'https://app.raijinshield.com/icons/icon-192.png', appUrl: 'https://app.raijinshield.com', assetsBaseUrl: 'https://app.raijinshield.com/email' };
const at = new Date('2026-11-22T10:00:00.000Z');

const payloads: Record<string, unknown> = {
  verdict_degraded: { from: 'safe', to: 'danger', reasonCodes: [], analysisId: null },
  lp_removed: { poolAddress: MINT, dex: 'raydium', dropPct: 42, liquidityUsdBefore: 1000, liquidityUsdAfter: 580, referenceAt: at.toISOString() },
  mint_reactivated: { revokedObservedAt: at.toISOString() },
  freeze_reactivated: { revokedObservedAt: at.toISOString() },
  holder_sold: { owner: MINT, beforePct: 8, afterPct: null, soldPctOfPosition: 100 },
};

function message(type: (typeof ALERT_TYPES)[number], name = 'Bonk'): AlertMessage {
  return {
    id: '01968b3a-7c2e-7d4a-9f00-0123456789ab',
    mint: MINT,
    severity: type === 'holder_sold' ? 'warn' : 'danger',
    token: { mint: MINT, name, symbol: null, decimals: 5, tokenProgram: 'spl-token', untrusted: true },
    createdAt: at,
    type,
    payload: payloads[type],
  } as AlertMessage;
}

describe('e-mail d’alerte groupé', () => {
  it('Rai en PNG 2x avec texte alternatif, une ligne par alerte, liens absolus, préférences, mention légale', () => {
    const mail = alertDigestTemplate(ctx, ALERT_TYPES.map((type) => message(type)));
    expect(mail.subject).toBe('5 alertes sur tes tokens suivis (Danger)');
    expect(mail.html).toContain('src="https://app.raijinshield.com/email/rai-alerte@2x.png" width="120" height="140"');
    expect(mail.html).toContain(`alt="${RAI_ALERT_ALT}"`);
    expect(mail.html).toContain(`https://app.raijinshield.com/analyse/${MINT}`);
    expect(mail.html).toContain('https://app.raijinshield.com/alertes');
    expect(mail.html).toContain('https://app.raijinshield.com/compte?section=notifications');
    expect(mail.html).toContain(LEGAL_NOTICE);
    expect(mail.text).toContain(LEGAL_NOTICE);
    expect(mail.html).toContain('(non vérifié)');
    for (const type of ALERT_TYPES) expect(mail.text).toContain(describeAlert(message(type)));
  });

  it('une seule alerte : objet explicite ; nom hostile échappé', () => {
    const mail = alertDigestTemplate(ctx, [message('mint_reactivated', '<img src=x onerror=alert(1)>')]);
    expect(mail.subject).toMatch(/^Alerte Danger : Mint réactivé sur /);
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('&lt;img src=x');
  });

  it('textes des événements en français, chiffres formatés', () => {
    expect(describeAlert(message('verdict_degraded'))).toBe('Le verdict passe de Sain à Danger.');
    expect(describeAlert(message('holder_sold'))).toContain('sorti du top 20');
    expect(describeAlert({ type: 'holder_sold', payload: { owner: MINT, beforePct: 10, afterPct: 6, soldPctOfPosition: 40 } })).toContain('6 % de l’offre');
  });
});

describe('résumé hebdomadaire', () => {
  it('verdict et alertes par suivi, lien de désinscription', () => {
    const mail = weeklyDigestTemplate(ctx, [
      { mint: MINT, token: null, lastVerdict: 'warn', alertsThisWeek: 2 },
      { mint: MINT, token: null, lastVerdict: null, alertsThisWeek: 0 },
    ]);
    expect(mail.subject).toBe('Ton résumé Raijin de la semaine : 2 alertes');
    expect(mail.html).toContain('Verdict : Prudence');
    expect(mail.html).toContain('en attente');
    expect(mail.html).toContain('Ne plus recevoir le résumé hebdomadaire');
    expect(weeklyDigestTemplate(ctx, []).subject).toContain('aucune alerte');
  });

  it('accorde la phrase au singulier avec 1 token suivi', () => {
    const mail = weeklyDigestTemplate(ctx, [{ mint: MINT, token: null, lastVerdict: 'warn', alertsThisWeek: 1 }]);
    expect(mail.subject).toBe('Ton résumé Raijin de la semaine : 1 alerte');
    expect(mail.html).toContain('Voici l’état de ton token suivi cette semaine.');
    expect(mail.text).toContain('Voici l’état de ton token suivi cette semaine.');
    expect(mail.text).toContain('1 alerte\n');
    expect(mail.html).not.toContain('tes 1 token');
    expect(mail.text).not.toContain('alerte(s)');
  });

  it('accorde la phrase au pluriel avec plusieurs tokens suivis', () => {
    const watch = { mint: MINT, token: null, lastVerdict: null, alertsThisWeek: 0 } as const;
    const mail = weeklyDigestTemplate(ctx, [watch, watch, { ...watch, alertsThisWeek: 3 }]);
    expect(mail.subject).toBe('Ton résumé Raijin de la semaine : 3 alertes');
    expect(mail.html).toContain('Voici l’état de tes 3 tokens suivis cette semaine.');
    expect(mail.text).toContain('Voici l’état de tes 3 tokens suivis cette semaine.');
    expect(mail.text).toContain('3 alertes');
    expect(mail.text).toContain('0 alerte\n');
  });

  it('phrase d’introduction sans suivi', () => {
    expect(digestIntro(0)).toBe('Tu ne suis aucun token pour le moment.');
  });
});
