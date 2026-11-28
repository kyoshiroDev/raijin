/**
 * Gabarit commun des e-mails : thème clair « Jour » de la charte (libs/brand/BRAND.md),
 * responsive (une colonne, 600 px max), tables pour la compatibilité des clients mail,
 * styles en ligne, logo PNG en en-tête, mention « pas un conseil en investissement » en pied.
 */

/**
 * Couleurs du thème clair, copiées de `libs/brand/tokens.json` (valeurs `light`).
 * Le test `email-theme.spec.ts` vérifie qu'elles restent identiques aux tokens.
 */
export const EMAIL_THEME = {
  base: '#f6f7f9',
  surface: '#ffffff',
  'surface-raised': '#eef1f5',
  line: '#d7dde6',
  ink: '#0b1017',
  'ink-muted': '#526073',
  thunder: '#facc15',
  'thunder-ink': '#7a5d00',
  'on-thunder': '#07090d',
  warn: '#a3480a',
  danger: '#be123c',
} as const;

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const DISPLAY = "'Space Grotesk', Inter, ui-sans-serif, system-ui, sans-serif";

export const LEGAL_NOTICE =
  'Raijin fournit des analyses de sécurité à titre informatif. Ce n’est pas un conseil en investissement.';

/** Échappe une valeur insérée dans le HTML (texte et attributs). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Bouton « à l'épreuve des clients mail » : jaune `thunder`, texte `on-thunder`. */
export function button(label: string, href: string): string {
  const t = EMAIL_THEME;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr><td style="border-radius:10px;background:${t.thunder};">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 24px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:${t['on-thunder']};text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}

/** Rai en PNG 2x (240×280 px) affiché en 120×140, centré (accueil, fin d'essai, alerte : PROMPT.md). */
export function raiImage(assetsBaseUrl: string, file: string, alt: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;"><tr><td align="center">
  <img src="${escapeHtml(`${assetsBaseUrl}/${file}`)}" width="120" height="140" alt="${escapeHtml(alt)}" style="display:block;border:0;width:120px;height:140px;">
</td></tr></table>`;
}

/** Paragraphe de texte. */
export function paragraph(text: string, muted = false): string {
  const color = muted ? EMAIL_THEME['ink-muted'] : EMAIL_THEME.ink;
  const size = muted ? '13px' : '15px';
  const lineHeight = muted ? '20px' : '24px';
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:${size};line-height:${lineHeight};color:${color};">${escapeHtml(text)}</p>`;
}

/** Lien de secours affiché en clair sous le bouton (copier-coller). */
export function fallbackLink(href: string): string {
  const t = EMAIL_THEME;
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:13px;line-height:20px;color:${t['ink-muted']};">Si le bouton ne marche pas, copie ce lien dans ton navigateur :<br><a href="${escapeHtml(href)}" style="color:${t['thunder-ink']};word-break:break-all;">${escapeHtml(href)}</a></p>`;
}

export interface LayoutInput {
  readonly title: string;
  /** Aperçu affiché par les clients mail à côté de l'objet. */
  readonly preheader: string;
  /** Contenu HTML déjà échappé (construit avec `paragraph`, `button`…). */
  readonly body: string;
  readonly logoUrl: string;
  readonly appUrl: string;
}

export function renderLayout(input: LayoutInput): string {
  const t = EMAIL_THEME;
  return `<!doctype html>
<html lang="fr" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(input.title)}</title>
<style>
  @media (max-width: 620px) {
    .rj-card { padding: 24px 16px !important; }
    .rj-title { font-size: 22px !important; line-height: 30px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${t.base};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${t.base};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
      <tr><td style="padding:0 0 16px;">
        <a href="${escapeHtml(input.appUrl)}" style="text-decoration:none;">
          <img src="${escapeHtml(input.logoUrl)}" width="40" height="40" alt="Raijin" style="display:inline-block;vertical-align:middle;border:0;border-radius:10px;">
          <span style="display:inline-block;vertical-align:middle;margin-left:8px;font-family:${DISPLAY};font-size:20px;font-weight:700;color:${t.ink};">Raijin</span>
        </a>
      </td></tr>
      <tr><td class="rj-card" style="background:${t.surface};border:1px solid ${t.line};border-radius:16px;padding:32px 24px;">
        <h1 class="rj-title" style="margin:0 0 16px;font-family:${DISPLAY};font-size:24px;line-height:32px;font-weight:700;color:${t.ink};">${escapeHtml(input.title)}</h1>
        ${input.body}
      </td></tr>
      <tr><td style="padding:16px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${t['ink-muted']};">
        ${escapeHtml(LEGAL_NOTICE)}<br>
        Raijin · lecture seule on-chain, aucune signature ni transaction.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Version texte : paragraphes séparés par une ligne vide, pied identique. */
export function renderText(lines: readonly string[]): string {
  return `${lines.join('\n\n')}\n\n--\n${LEGAL_NOTICE}\nRaijin · lecture seule on-chain, aucune signature ni transaction.\n`;
}
