import type { Entitlements } from '@raijin/shared-contracts';
import { LEGAL_NOTICE } from './layout';
import { freePlanLines, GIFT_ENDED_SUBJECT, giftEndedTemplate, recapLines, TRIAL_MAIL_SUBJECTS, trialDay1Template, trialDayMinus2Template, trialEndedTemplate, type TrialMailRecap } from './trial-templates';

const ctx = { logoUrl: 'https://app.raijinshield.com/icons/icon-192.png', appUrl: 'https://app.raijinshield.com', assetsBaseUrl: 'https://app.raijinshield.com/email' };
const free: Entitlements = { analysesPerDay: 5, maxActiveWatches: 3, pushAlerts: false, walletScansPerDay: 0, alertHistoryDays: 30 };
const recap: TrialMailRecap = { analysesCount: 12, alertsCount: 1, dangerTokensCount: 2, walletScansCount: 0, activeWatches: 3, planLimitPausedWatches: 2 };
const END = new Date('2026-11-30T08:00:00.000Z');

const all = () => [trialDay1Template(ctx, recap), trialDayMinus2Template(ctx, recap, END, free), trialEndedTemplate(ctx, recap, free)];

describe('e-mails de l’essai Pro', () => {
  it('objets imposés, tutoiement, mention « pas un conseil en investissement », liens absolus', () => {
    const [day1, minus2, ended] = all();
    expect(day1?.subject).toBe('Voilà ce que Raijin a vérifié pour toi');
    expect(minus2?.subject).toBe('Ton essai se termine dans 2 jours');
    expect(ended?.subject).toBe('Tu repasses en Gratuit');
    expect(Object.values(TRIAL_MAIL_SUBJECTS)).toHaveLength(3);
    for (const mail of all()) {
      expect(mail.html).toContain(LEGAL_NOTICE);
      expect(mail.text).toContain(LEGAL_NOTICE);
      expect(mail.text).not.toContain('<');
      expect(mail.html).not.toMatch(/\svous\s/i);
      expect(mail.html).toContain('max-width:600px');
    }
  });

  it('récapitulatif : analyses, tokens Danger évités, alertes, scans (accords au singulier et au pluriel)', () => {
    expect(recapLines(recap)).toEqual([
      '12 tokens analysés',
      '2 tokens classés Danger repérés avant d’y toucher',
      '1 alerte reçue sur tes suivis',
      '0 scan de wallet',
    ]);
    const [day1] = all();
    expect(day1?.html).toContain('12 tokens analysés');
    expect(trialDay1Template(ctx, { ...recap, analysesCount: 0 }).text).toContain('Tu n’as pas encore analysé de token');
  });

  it('Rai seulement sur J0 (fin d’essai), jamais sur J+1 ni J-2', () => {
    const [day1, minus2, ended] = all();
    expect(day1?.html).not.toContain('rai-');
    expect(minus2?.html).not.toContain('rai-');
    expect(ended?.html).toContain('src="https://app.raijinshield.com/email/rai-bravo@2x.png" width="120" height="140"');
    expect(ended?.html).toContain('alt="Rai, la mascotte de Raijin"');
  });

  it('J-2 et J0 : ce qui change (valeurs de la configuration), bouton « Garder Pro » vers /abonnement', () => {
    expect(freePlanLines(free)).toEqual([
      '5 analyses par jour',
      '3 tokens suivis avec alertes par e-mail',
      'Historique des alertes sur 30 jours',
      'Pas de notifications push',
      'Pas de scan de wallet',
    ]);
    expect(freePlanLines({ ...free, analysesPerDay: null, pushAlerts: true, walletScansPerDay: 1, maxActiveWatches: 1 })).toEqual([
      'Analyses illimitées',
      '1 token suivi avec alertes par e-mail',
      'Historique des alertes sur 30 jours',
      'Notifications push',
      '1 scan de wallet par jour',
    ]);
    const [, minus2, ended] = all();
    for (const mail of [minus2, ended]) {
      expect(mail?.html).toContain('Garder Pro');
      expect(mail?.html).toContain('href="https://app.raijinshield.com/abonnement"');
      expect(mail?.text).toContain('5 analyses par jour');
    }
    expect(minus2?.text).toContain('lundi 30 novembre');
    expect(minus2?.text).toContain('sans rien payer');
  });

  it('J0 : suivis mis en pause, jamais supprimés, lien pour choisir ; toujours envoyé (pas de lien de désinscription)', () => {
    const [, , ended] = all();
    expect(ended?.text).toContain('2 suivis ont été mis en pause');
    expect(ended?.text).toContain('Rien n’est supprimé');
    expect(ended?.html).toContain('https://app.raijinshield.com/suivis');
    expect(ended?.html).not.toContain('Ne plus recevoir');
    const none = trialEndedTemplate(ctx, { ...recap, planLimitPausedWatches: 0 }, free);
    expect(none.text).not.toContain('en pause');
    expect(trialEndedTemplate(ctx, { ...recap, planLimitPausedWatches: 1 }, free).text).toContain('1 suivi a été mis en pause');
  });

  it('J+1 et J-2 désactivables : lien vers les préférences', () => {
    const [day1, minus2] = all();
    for (const mail of [day1, minus2]) {
      expect(mail?.html).toContain('Ne plus recevoir les e-mails pendant l’essai');
      expect(mail?.text).toContain('https://app.raijinshield.com/compte?section=notifications');
    }
  });

  it('aucune urgence artificielle ni promesse de gain', () => {
    const text = all()
      .map((mail) => `${mail.subject} ${mail.text}`.toLowerCase())
      .join(' ');
    for (const forbidden of ['dernière chance', 'vite', 'urgent', 'dépêche', 'offre limitée', 'x10', 'moon', 'gain', 'opportunité', '!']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('giftEndedTemplate (fin du Pro offert)', () => {
  it('neutre : pas d’urgence ni de Rai, limites du Gratuit, suivis en pause seulement s’il y en a', () => {
    const mail = giftEndedTemplate(ctx, 0, free);
    expect(mail.subject).toBe(GIFT_ENDED_SUBJECT);
    expect(mail.html).not.toContain('rai-');
    expect(mail.text).toContain('plan Gratuit');
    expect(mail.text).not.toContain('en pause');
    expect(mail.text).not.toMatch(/dernière chance|vite|urgent/i);
    expect(giftEndedTemplate(ctx, 2, free).text).toContain('2 suivis ont été mis en pause');
  });
});
