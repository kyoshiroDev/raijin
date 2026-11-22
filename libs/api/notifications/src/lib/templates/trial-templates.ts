import type { Entitlements, TrialRecap } from '@raijin/shared-contracts';
import type { RenderedMail } from './auth-templates';
import type { WatchMailContext } from './alert-templates';
import { button, EMAIL_THEME, escapeHtml, paragraph, raiImage, renderLayout, renderText } from './layout';

/**
 * E-mails de l'essai Pro (docs/ARCHITECTURE.md §13.7) : tutoiement, ton calme, aucune urgence
 * artificielle, aucune promesse de gain. Rai seulement sur J0 (fin d'essai). J+1 et J-2 sont
 * désactivables (préférence `trialEmails`) ; J0 part toujours (information sur le compte).
 */

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export const SUBSCRIPTION_PATH = '/abonnement';
export const TRIAL_PREFERENCES_PATH = '/compte?section=notifications';
export const TRIAL_WATCHES_PATH = '/suivis';
export const RAI_TRIAL_END_FILE = 'rai-bravo@2x.png';
export const RAI_TRIAL_END_ALT = 'Rai, la mascotte de Raijin';

export const TRIAL_MAIL_SUBJECTS = {
  day1: 'Voilà ce que Raijin a vérifié pour toi',
  dayMinus2: 'Ton essai se termine dans 2 jours',
  ended: 'Tu repasses en Gratuit',
} as const;

/** Récapitulatif utilisé par les e-mails (sous-ensemble de `TrialRecap`). */
export type TrialMailRecap = Pick<
  TrialRecap,
  'analysesCount' | 'alertsCount' | 'dangerTokensCount' | 'walletScansCount' | 'activeWatches' | 'planLimitPausedWatches'
>;

function url(ctx: WatchMailContext, path: string): string {
  return new URL(path, ctx.appUrl).toString();
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** Lignes du récapitulatif (texte brut, reprises en HTML). */
export function recapLines(recap: TrialMailRecap): string[] {
  return [
    `${plural(recap.analysesCount, 'token analysé', 'tokens analysés')}`,
    `${plural(recap.dangerTokensCount, 'token classé Danger', 'tokens classés Danger')} repéré${recap.dangerTokensCount > 1 ? 's' : ''} avant d’y toucher`,
    `${plural(recap.alertsCount, 'alerte reçue', 'alertes reçues')} sur tes suivis`,
    `${plural(recap.walletScansCount, 'scan de wallet', 'scans de wallet')}`,
  ];
}

function recapTable(recap: TrialMailRecap): string {
  const t = EMAIL_THEME;
  const rows = recapLines(recap)
    .map(
      (line) =>
        `<tr><td style="padding:8px 12px;border-top:1px solid ${t.line};font-family:${FONT};font-size:14px;line-height:21px;color:${t.ink};">${escapeHtml(line)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;background:${t['surface-raised']};border-radius:12px;">${rows}</table>`;
}

/** Ce que le plan Gratuit garde (valeurs de la configuration, jamais en dur). */
export function freePlanLines(free: Entitlements): string[] {
  return [
    `${free.analysesPerDay === null ? 'Analyses illimitées' : plural(free.analysesPerDay, 'analyse par jour', 'analyses par jour')}`,
    `${plural(free.maxActiveWatches, 'token suivi', 'tokens suivis')} avec alertes par e-mail`,
    `Historique des alertes sur ${free.alertHistoryDays} jours`,
    free.pushAlerts ? 'Notifications push' : 'Pas de notifications push',
    free.walletScansPerDay > 0 ? plural(free.walletScansPerDay, 'scan de wallet par jour', 'scans de wallet par jour') : 'Pas de scan de wallet',
  ];
}

function list(lines: readonly string[]): string {
  const t = EMAIL_THEME;
  return `<ul style="margin:0 0 16px;padding-left:20px;font-family:${FONT};font-size:14px;line-height:22px;color:${t.ink};">${lines
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('')}</ul>`;
}

function preferencesLink(ctx: WatchMailContext): string {
  const href = url(ctx, TRIAL_PREFERENCES_PATH);
  return `<p style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;"><a href="${escapeHtml(href)}" style="color:${EMAIL_THEME['thunder-ink']};">Ne plus recevoir les e-mails pendant l’essai</a></p>`;
}

/** J+1 : ce que Raijin a vérifié pendant la première journée, et ce que l'essai permet encore. */
export function trialDay1Template(ctx: WatchMailContext, recap: TrialMailRecap): RenderedMail {
  const subject = TRIAL_MAIL_SUBJECTS.day1;
  const intro =
    recap.analysesCount > 0
      ? 'Ton essai Pro tourne depuis un jour. Voici ce que Raijin a vérifié pour toi jusqu’ici :'
      : 'Ton essai Pro tourne depuis un jour. Tu n’as pas encore analysé de token : colle une adresse Solana et Raijin vérifie les points qui comptent.';
  const tips = [
    'Suis les tokens que tu détiens : Raijin te prévient si la liquidité bouge ou si une autorité réapparaît.',
    'Scanne ton wallet pour voir d’un coup d’œil les tokens à surveiller.',
  ];
  const analyse = url(ctx, '/analyse');
  const body = [
    paragraph(intro),
    recap.analysesCount > 0 ? recapTable(recap) : '',
    paragraph('Pendant l’essai, tu peux aussi :'),
    list(tips),
    button('Analyser un token', analyse),
    paragraph('Le risque zéro n’existe pas : Raijin te donne des faits, à toi de décider.', true),
    preferencesLink(ctx),
  ]
    .filter(Boolean)
    .join('\n');
  return {
    subject,
    html: renderLayout({ title: subject, preheader: 'Le point sur ta première journée d’essai Pro.', body, logoUrl: ctx.logoUrl, appUrl: ctx.appUrl }),
    text: renderText([
      intro,
      ...(recap.analysesCount > 0 ? recapLines(recap).map((line) => `- ${line}`) : []),
      'Pendant l’essai, tu peux aussi :',
      ...tips.map((tip) => `- ${tip}`),
      `Analyser un token : ${analyse}`,
      `Ne plus recevoir les e-mails pendant l’essai : ${url(ctx, TRIAL_PREFERENCES_PATH)}`,
    ]),
  };
}

/** J-2 : récapitulatif, ce qui changera à la fin, sans pression. */
export function trialDayMinus2Template(ctx: WatchMailContext, recap: TrialMailRecap, endsAt: Date, free: Entitlements): RenderedMail {
  const subject = TRIAL_MAIL_SUBJECTS.dayMinus2;
  const date = endsAt.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
  const intro = `Ton essai Pro se termine le ${date}. Voici ce que Raijin a vérifié pour toi pendant l’essai :`;
  const after = 'Ensuite, ton compte repasse en Gratuit tout seul, sans rien payer. Tu gardes :';
  const keep = 'Si Pro t’est utile, tu peux le garder depuis la page Abonnement. Sinon, tu n’as rien à faire.';
  const subscription = url(ctx, SUBSCRIPTION_PATH);
  const body = [
    paragraph(intro),
    recapTable(recap),
    paragraph(after),
    list(freePlanLines(free)),
    paragraph(keep),
    button('Garder Pro', subscription),
    preferencesLink(ctx),
  ].join('\n');
  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Fin de l’essai le ${date}.`, body, logoUrl: ctx.logoUrl, appUrl: ctx.appUrl }),
    text: renderText([
      intro,
      ...recapLines(recap).map((line) => `- ${line}`),
      after,
      ...freePlanLines(free).map((line) => `- ${line}`),
      keep,
      `Garder Pro : ${subscription}`,
      `Ne plus recevoir les e-mails pendant l’essai : ${url(ctx, TRIAL_PREFERENCES_PATH)}`,
    ]),
  };
}

/** J0 : fin de l'essai (toujours envoyé). Rai, récapitulatif, ce qui change, suivis mis en pause. */
export function trialEndedTemplate(ctx: WatchMailContext, recap: TrialMailRecap, free: Entitlements): RenderedMail {
  const subject = TRIAL_MAIL_SUBJECTS.ended;
  const intro = 'Ton essai Pro est terminé et ton compte est en plan Gratuit. Merci d’avoir essayé Raijin. Pendant l’essai :';
  const changes = 'Avec le plan Gratuit :';
  const paused =
    recap.planLimitPausedWatches > 0
      ? `${plural(recap.planLimitPausedWatches, 'suivi a été mis', 'suivis ont été mis')} en pause pour respecter la limite du plan Gratuit. Rien n’est supprimé : tu peux choisir les ${plural(free.maxActiveWatches, 'token', 'tokens')} à garder.`
      : null;
  const keep = 'Tu peux passer à Pro quand tu veux depuis la page Abonnement.';
  const subscription = url(ctx, SUBSCRIPTION_PATH);
  const watches = url(ctx, TRIAL_WATCHES_PATH);
  const body = [
    raiImage(ctx.assetsBaseUrl, RAI_TRIAL_END_FILE, RAI_TRIAL_END_ALT),
    paragraph(intro),
    recapTable(recap),
    paragraph(changes),
    list(freePlanLines(free)),
    paused ? paragraph(paused) : '',
    paused
      ? `<p style="margin:0 0 16px;font-family:${FONT};font-size:14px;line-height:21px;"><a href="${escapeHtml(watches)}" style="color:${EMAIL_THEME['thunder-ink']};">Choisir mes suivis</a></p>`
      : '',
    paragraph(keep),
    button('Garder Pro', subscription),
    paragraph('Tu reçois cet e-mail parce que ton essai Pro vient de se terminer : il informe sur l’état de ton compte.', true),
  ]
    .filter(Boolean)
    .join('\n');
  return {
    subject,
    html: renderLayout({ title: subject, preheader: 'Ton essai Pro est terminé, ton compte reste actif en Gratuit.', body, logoUrl: ctx.logoUrl, appUrl: ctx.appUrl }),
    text: renderText([
      intro,
      ...recapLines(recap).map((line) => `- ${line}`),
      changes,
      ...freePlanLines(free).map((line) => `- ${line}`),
      ...(paused ? [paused, `Choisir mes suivis : ${watches}`] : []),
      keep,
      `Garder Pro : ${subscription}`,
    ]),
  };
}
