import type { RenderedMail, TemplateContext } from './auth-templates';
import { button, EMAIL_THEME, escapeHtml, paragraph, renderLayout, renderText } from './layout';

/**
 * E-mail d'alerte admin (docs/ARCHITECTURE.md §14.7) : job en échec répété ou quota proche de sa limite. Thème clair,
 * texte neutre. Contenu limité au job ou au service, aux compteurs et au code d'erreur : jamais de secret, d'URL
 * d'API ni de donnée utilisateur.
 */

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

/** Chemin de l'écran Santé technique de l'admin. */
export const ADMIN_HEALTH_PATH = '/admin/sante';

export interface AdminAlertMailItem {
  readonly kind: 'job_failing' | 'quota_threshold';
  /** Libellé du job ou du service (texte maîtrisé par Raijin). */
  readonly label: string;
  readonly level: 'warning' | 'critical';
  readonly consecutiveFailures?: number;
  readonly lastErrorCode?: string;
  readonly used?: number;
  readonly limit?: number;
  readonly ratio?: number;
}

const percent = (ratio: number) => `${Math.round(ratio * 100)} %`;
const count = (value: number) => new Intl.NumberFormat('fr-FR').format(value);

/** Ligne de texte d'une alerte (reprise en HTML). */
export function adminAlertLine(item: AdminAlertMailItem): string {
  if (item.kind === 'job_failing') {
    const failures = item.consecutiveFailures ?? 0;
    const code = item.lastErrorCode ? `, dernier code : ${item.lastErrorCode}` : '';
    return `${item.label} : ${failures} échec${failures > 1 ? 's' : ''} de suite${code}.`;
  }
  const usage = item.used !== undefined && item.limit !== undefined ? ` (${count(item.used)} sur ${count(item.limit)})` : '';
  return `${item.label} : ${percent(item.ratio ?? 0)} du quota du jour utilisé${usage}.`;
}

export function adminAlertSubject(items: readonly AdminAlertMailItem[]): string {
  const critical = items.some((item) => item.level === 'critical');
  return items.length === 1
    ? `Raijin admin : ${items[0]?.kind === 'job_failing' ? 'un job échoue' : 'quota presque atteint'}`
    : `Raijin admin : ${items.length} alertes${critical ? ' (dont critique)' : ''}`;
}

export function adminAlertTemplate(ctx: TemplateContext, items: readonly AdminAlertMailItem[]): RenderedMail {
  const subject = adminAlertSubject(items);
  const health = new URL(ADMIN_HEALTH_PATH, ctx.appUrl).toString();
  const intro = 'La surveillance de Raijin a relevé :';
  const rows = items
    .map((item) => {
      const color = item.level === 'critical' ? EMAIL_THEME.danger : EMAIL_THEME.warn;
      const tag = item.level === 'critical' ? 'Critique' : 'Attention';
      return `<tr><td style="padding:8px 0;border-bottom:1px solid ${EMAIL_THEME.line};font-family:${FONT};font-size:14px;line-height:21px;color:${EMAIL_THEME.ink};">
  <span style="display:inline-block;padding:2px 8px;margin-right:8px;border-radius:6px;border:1px solid ${color};color:${color};font-size:12px;font-weight:600;">${tag}</span>
  <span style="font-family:${MONO};">${escapeHtml(adminAlertLine(item))}</span>
</td></tr>`;
    })
    .join('\n');
  const outro = 'Une alerte n’est envoyée qu’une fois par incident. Le détail est dans l’écran Santé technique (connexion et code 2FA requis).';
  const body = [
    paragraph(intro),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${rows}</table>`,
    button('Ouvrir la santé technique', health),
    paragraph(outro, true),
  ].join('\n');
  return {
    subject,
    html: renderLayout({ title: subject, preheader: adminAlertLine(items[0] as AdminAlertMailItem), body, logoUrl: ctx.logoUrl, appUrl: ctx.appUrl }),
    text: renderText([intro, ...items.map((item) => `- ${adminAlertLine(item)}`), `Santé technique : ${health}`, outro]),
  };
}
