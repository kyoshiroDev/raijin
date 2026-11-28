import type { RenderedMail, TemplateContext } from './auth-templates';
import { paragraph, renderLayout, renderText } from './layout';

/** Longueurs maximales d'un avis d'exploitation (titre, corps en texte brut). */
export const ADMIN_NOTICE_TITLE_MAX = 120;
export const ADMIN_NOTICE_BODY_MAX = 2_000;

/** Caractère de contrôle (sauf retour à la ligne et tabulation) ou de mise en forme bidirectionnelle / invisible. */
function isControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Texte brut borné et nettoyé (jamais interprété : chaque ligne est échappée dans le HTML). */
export function cleanNoticeText(value: string, max: number): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  let clean = '';
  for (const char of normalized) if (!isControl(char.codePointAt(0) ?? 0)) clean += char;
  return clean.trim().slice(0, max);
}

/**
 * Titre d'un avis (sujet de l'e-mail, titre push) : sur une seule ligne. Retours à la ligne, tabulations et caractères
 * de contrôle deviennent des espaces (pas d'injection d'en-tête), espaces consécutives réduites, longueur bornée.
 */
export function cleanNoticeTitle(value: string, max = ADMIN_NOTICE_TITLE_MAX): string {
  let flat = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    flat += code === 0x09 || code === 0x0a || code === 0x0d || isControl(code) || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }
  return flat.replace(/ {2,}/g, ' ').trim().slice(0, max).trim();
}

/**
 * Avis d'exploitation aux admins (phase 8 : watchdog, sauvegardes, via la CLI `notify-admins`) : thème clair, titre et
 * corps en texte brut fournis par les scripts d'infra, échappés ; aucun lien hors de l'app.
 */
export function adminNoticeTemplate(ctx: TemplateContext, rawTitle: string, rawBody: string): RenderedMail {
  const title = cleanNoticeTitle(rawTitle) || 'Avis d’exploitation';
  const lines = cleanNoticeText(rawBody, ADMIN_NOTICE_BODY_MAX)
    .split(/\n{2,}|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const subject = `Raijin admin : ${title}`;
  const footer = 'Avis envoyé par les scripts d’exploitation du serveur (watchdog, sauvegardes) aux comptes admin.';
  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: title,
      body: [...lines.map((line) => paragraph(line)), paragraph(footer, true)].join('\n'),
      logoUrl: ctx.logoUrl,
      appUrl: ctx.appUrl,
    }),
    text: renderText([subject, ...lines, footer]),
  };
}
