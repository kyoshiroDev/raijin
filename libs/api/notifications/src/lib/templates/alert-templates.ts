import { VERDICT_LABELS, type Verdict } from '@raijin/shared-contracts';
import { alertTitle, describeAlert, severityLabel, tokenLabel, type AlertMessage } from './alert-text';
import type { RenderedMail, TemplateContext } from './auth-templates';
import { button, EMAIL_THEME, escapeHtml, paragraph, raiImage, renderLayout, renderText } from './layout';

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Contexte des e-mails de suivi : liens absolus construits avec APP_URL, jamais avec l'en-tête Host. */
export interface WatchMailContext extends TemplateContext {
  /** URL de base des images (Rai en PNG 2x), sans `/` final. */
  readonly assetsBaseUrl: string;
}

export const RAI_ALERT_ALT = 'Rai, la mascotte de Raijin, en alerte';
export const RAI_BRAVO_ALT = 'Rai, la mascotte de Raijin';
/** Chemins des préférences et des écrans liés (front). */
export const ALERTS_PATH = '/alertes';
export const WATCHES_PATH = '/suivis';
export const PREFERENCES_PATH = '/compte?section=notifications';

function url(ctx: TemplateContext, path: string): string {
  return new URL(path, ctx.appUrl).toString();
}

/** Rai en PNG 2x (240×280 px) affiché en 120×140, centré. */
function rai(ctx: WatchMailContext, file: string, alt: string): string {
  return raiImage(ctx.assetsBaseUrl, file, alt);
}

/** Gravité : icône + mot (jamais la couleur seule), couleurs `warn` / `danger` du thème clair. */
function badge(label: string, danger: boolean): string {
  const color = danger ? EMAIL_THEME.danger : EMAIL_THEME.warn;
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid ${color};background:${EMAIL_THEME['surface-raised']};color:${color};font-family:${FONT};font-size:12px;font-weight:700;line-height:18px;">${danger ? '⚡' : '⚠'} ${escapeHtml(label)}</span>`;
}

function alertRow(ctx: TemplateContext, alert: AlertMessage): string {
  const t = EMAIL_THEME;
  const analysis = url(ctx, `/analyse/${alert.mint}`);
  return `<tr><td style="padding:12px 0;border-top:1px solid ${t.line};">
  ${badge(severityLabel(alert.severity), alert.severity === 'danger')}
  <p style="margin:8px 0 4px;font-family:${FONT};font-size:15px;line-height:22px;font-weight:600;color:${t.ink};">${escapeHtml(alertTitle(alert))} · ${escapeHtml(tokenLabel(alert.mint, alert.token))} <span style="font-weight:400;color:${t['ink-muted']};">(non vérifié)</span></p>
  <p style="margin:0 0 4px;font-family:${FONT};font-size:14px;line-height:21px;color:${t.ink};">${escapeHtml(describeAlert(alert))}</p>
  <a href="${escapeHtml(analysis)}" style="font-family:${FONT};font-size:13px;line-height:20px;color:${t['thunder-ink']};">Voir l’analyse du token</a>
</td></tr>`;
}

/** Pire gravité du lot : affichée en tête (verdict). */
function worst(alerts: readonly AlertMessage[]): 'danger' | 'warn' {
  return alerts.some((alert) => alert.severity === 'danger') ? 'danger' : 'warn';
}

/**
 * E-mail d'alerte groupé (docs/ARCHITECTURE.md §11.8) : Rai en alerte au-dessus du verdict, une
 * ligne par alerte (type, token tronqué « non vérifié », chiffres, lien vers l'analyse), bouton vers
 * `/alertes`, mention « pas un conseil en investissement » (gabarit), lien vers les préférences.
 */
export function alertDigestTemplate(ctx: WatchMailContext, alerts: readonly AlertMessage[]): RenderedMail {
  const level = severityLabel(worst(alerts));
  const count = alerts.length;
  const first = alerts[0];
  const subject =
    count === 1 && first
      ? `Alerte ${level} : ${alertTitle(first)} sur ${tokenLabel(first.mint, first.token)}`
      : `${count} alertes sur tes tokens suivis (${level})`;
  const preferences = url(ctx, PREFERENCES_PATH);
  const body = `${rai(ctx, 'rai-alerte@2x.png', RAI_ALERT_ALT)}
${paragraph(`Niveau le plus grave : ${level}. ${count === 1 ? 'Un événement a été détecté' : `${count} événements ont été détectés`} sur des tokens que tu suis.`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${alerts.map((alert) => alertRow(ctx, alert)).join('')}</table>
${button('Voir mes alertes', url(ctx, ALERTS_PATH))}
${paragraph('Ces signaux sont calculés à partir de données publiques on-chain. Vérifie toujours par toi-même.', true)}
${paragraph('Tu reçois cet e-mail parce que les alertes par e-mail sont activées sur ton compte Raijin.', true)}
<p style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;"><a href="${escapeHtml(preferences)}" style="color:${EMAIL_THEME['thunder-ink']};">Désactiver ces e-mails ou modifier mes préférences</a></p>`;
  const text = renderText([
    `Niveau le plus grave : ${level}.`,
    ...alerts.map(
      (alert) =>
        `[${severityLabel(alert.severity)}] ${alertTitle(alert)} · ${tokenLabel(alert.mint, alert.token)} (non vérifié)\n${describeAlert(alert)}\nAnalyse : ${url(ctx, `/analyse/${alert.mint}`)}`,
    ),
    `Voir mes alertes : ${url(ctx, ALERTS_PATH)}`,
    `Désactiver ces e-mails ou modifier mes préférences : ${preferences}`,
  ]);
  return {
    subject,
    html: renderLayout({ title: `Alerte ${level}`, preheader: subject, body, logoUrl: ctx.logoUrl, appUrl: ctx.appUrl }),
    text,
  };
}

/** Ligne du résumé hebdomadaire : un suivi. */
export interface DigestWatch {
  readonly mint: string;
  readonly token: AlertMessage['token'];
  readonly lastVerdict: Verdict | null;
  readonly alertsThisWeek: number;
}

/** Résumé hebdomadaire (optionnel, désactivable) : verdict actuel et alertes de la semaine par suivi. */
export function weeklyDigestTemplate(ctx: WatchMailContext, watches: readonly DigestWatch[]): RenderedMail {
  const t = EMAIL_THEME;
  const total = watches.reduce((sum, watch) => sum + watch.alertsThisWeek, 0);
  const subject = total === 0 ? 'Ton résumé Raijin de la semaine : aucune alerte' : `Ton résumé Raijin de la semaine : ${total} alerte${total > 1 ? 's' : ''}`;
  const preferences = url(ctx, PREFERENCES_PATH);
  const verdict = (value: Verdict | null) => (value ? VERDICT_LABELS[value] : 'en attente');
  const rows = watches
    .map(
      (watch) => `<tr><td style="padding:10px 0;border-top:1px solid ${t.line};font-family:${FONT};font-size:14px;line-height:21px;color:${t.ink};">
  <strong>${escapeHtml(tokenLabel(watch.mint, watch.token))}</strong> <span style="color:${t['ink-muted']};">(non vérifié)</span><br>
  Verdict : ${escapeHtml(verdict(watch.lastVerdict))} · Alertes cette semaine : ${watch.alertsThisWeek}
</td></tr>`,
    )
    .join('');
  const body = `${rai(ctx, 'rai-bravo@2x.png', RAI_BRAVO_ALT)}
${paragraph(`Voici l’état de tes ${watches.length} token${watches.length > 1 ? 's' : ''} suivi${watches.length > 1 ? 's' : ''} cette semaine.`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
${button('Voir mes suivis', url(ctx, WATCHES_PATH))}
<p style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;"><a href="${escapeHtml(preferences)}" style="color:${t['thunder-ink']};">Ne plus recevoir le résumé hebdomadaire</a></p>`;
  const text = renderText([
    `Voici l’état de tes ${watches.length} tokens suivis cette semaine.`,
    ...watches.map((watch) => `${tokenLabel(watch.mint, watch.token)} (non vérifié) : verdict ${verdict(watch.lastVerdict)}, ${watch.alertsThisWeek} alerte(s)`),
    `Voir mes suivis : ${url(ctx, WATCHES_PATH)}`,
    `Ne plus recevoir le résumé : ${preferences}`,
  ]);
  return {
    subject,
    html: renderLayout({ title: 'Ton résumé de la semaine', preheader: subject, body, logoUrl: ctx.logoUrl, appUrl: ctx.appUrl }),
    text,
  };
}
