import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, errorCode, GLOBAL_PREFIX, type AppConfig } from '@raijin/api-core';
import { ANALYSIS_DISCLAIMER, VERDICT_LABELS, type AnalysisResult } from '@raijin/shared-contracts';
import { sanitizeUntrustedText, truncateMiddle } from '@raijin/shared-util';
import { readFile, stat } from 'node:fs/promises';
import { AnalysisService } from '../analysis/analysis.service';
import { OG_HEIGHT, OG_WIDTH } from '../og/og-template';

/** Échappement HTML (texte et valeurs d'attributs entre guillemets doubles). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Balises remplacées dans l'`index.html` du build web (titre, description, OG, Twitter, canonique). */
const REPLACED_TAGS = [
  /<title\b[^>]*>[\s\S]*?<\/title>\s*/gi,
  /<meta\s+[^>]*name=["']description["'][^>]*>\s*/gi,
  /<meta\s+[^>]*property=["']og:[^"']*["'][^>]*>\s*/gi,
  /<meta\s+[^>]*name=["']twitter:[^"']*["'][^>]*>\s*/gi,
  /<link\s+[^>]*rel=["']canonical["'][^>]*>\s*/gi,
];

export interface SharePageMeta {
  readonly title: string;
  readonly description: string;
  readonly canonical: string;
  readonly image: string;
  readonly imageAlt: string;
}

/**
 * Page publique `/t/<mint>` pour les robots des réseaux sociaux (docs/ARCHITECTURE.md §9.7) :
 * `index.html` du build web (`WEB_INDEX_HTML_PATH`) avec titre, description, `og:*`, `twitter:*` et
 * canonique injectés, toutes les valeurs échappées. Le nom et le symbole du token, non fiables,
 * n'apparaissent qu'entre guillemets, marqués « non vérifié ». Angular démarre ensuite normalement.
 */
@Injectable()
export class SharePageService {
  private readonly logger = new Logger('SharePage');
  /** `index.html` en mémoire, relu dès que sa date de modification change (nouveau build web). */
  private template: { path: string; mtimeMs: number; html: string } | null = null;

  constructor(
    private readonly analyses: AnalysisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** HTML de la page publique d'un mint (`null` : mint invalide, page générique). */
  async render(mint: string | null): Promise<string> {
    const analysis = mint ? await this.analyses.findLatest(mint) : null;
    const template = await this.loadTemplate(mint);
    let html = template.html;
    // Verdict statique dans `<rj-root>` (§10.7) : seulement avec une analyse publiée et le gabarit du build web.
    if (mint && analysis && template.fromBuild) {
      const injected = injectStaticVerdict(html, renderStaticVerdict(analysis, mint));
      if (injected === null) this.logger.warn('Balise <rj-root> introuvable dans index.html, verdict statique non injecté');
      else html = injected;
    }
    return injectMeta(html, this.meta(mint, analysis));
  }

  meta(mint: string | null, analysis: AnalysisResult | null): SharePageMeta {
    const app = this.config.appUrl;
    const image = `${this.config.apiUrl}/${GLOBAL_PREFIX}/og/${mint ?? 'raijin'}.png`;
    if (!mint) {
      return {
        title: 'Analyse de token Solana · Raijin Shield',
        description: `Raijin Shield vérifie les signaux de rug d’un token Solana avant que tu signes. ${ANALYSIS_DISCLAIMER}`,
        canonical: `${app}/analyse`,
        image,
        imageAlt: 'Raijin Shield, analyse anti-rug des tokens Solana',
      };
    }
    const short = truncateMiddle(mint, 4, 4);
    if (!analysis) {
      return {
        title: `Token ${short} · Raijin Shield`,
        description: `Lance l’analyse anti-rug de ce token Solana avec Raijin Shield. ${ANALYSIS_DISCLAIMER}`,
        canonical: `${app}/t/${mint}`,
        image,
        imageAlt: `Analyse Raijin Shield du token ${short}`,
      };
    }
    const label = VERDICT_LABELS[analysis.verdict];
    const declared = analysis.token.symbol ?? analysis.token.name;
    const declaredPart = declared ? ` Symbole déclaré « ${declared} » (non vérifié).` : '';
    const description = `Verdict Raijin : ${label}.${declaredPart} ${analysis.explanation} ${ANALYSIS_DISCLAIMER}`;
    return {
      title: `${label} · token ${short} · Raijin Shield`,
      description: Array.from(description).slice(0, 300).join(''),
      canonical: `${app}/t/${mint}`,
      image,
      imageAlt: `Verdict Raijin Shield : ${label} pour le token ${short}`,
    };
  }

  /**
   * Gabarit du build web : un `stat` par requête (peu coûteux), relecture seulement si le fichier a
   * changé. Sans cela, après un nouveau build les noms des chunks changent et `/t/<mint>` resterait
   * blanche jusqu'au redémarrage de l'API.
   */
  private async loadTemplate(mint: string | null): Promise<{ html: string; fromBuild: boolean }> {
    const path = this.config.analysis.webIndexHtmlPath;
    const fallback = { html: minimalHtml(this.config.appUrl, mint), fromBuild: false };
    if (!path) return fallback;
    try {
      const { mtimeMs } = await stat(path);
      if (!this.template || this.template.path !== path || this.template.mtimeMs !== mtimeMs) {
        this.template = { path, mtimeMs, html: await readFile(path, 'utf8') };
      }
      return this.template.html.includes('</head>') ? { html: this.template.html, fromBuild: true } : fallback;
    } catch (error) {
      this.template = null;
      this.logger.warn(`index.html du build web illisible, HTML minimal servi (${errorCode(error)})`);
      return fallback;
    }
  }
}

/** Longueur maximale (points de code) du symbole ou du nom déclaré dans le verdict statique. */
const STATIC_TOKEN_MAX = 32;

const STATIC_DATE = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Verdict statique de `/t/<mint>` (docs/ARCHITECTURE.md §10.7), injecté dans `<rj-root>` : lisible sans
 * Angular, remplacé au démarrage de l'app. Toute valeur est échappée ; symbole ou nom (non fiables)
 * nettoyés (contrôles, invisibles, bidi), tronqués à 32 caractères, entre « » et marqués non vérifiés.
 * Aucun attribut `style`, aucun `on*`, aucun script, aucune URL issue des données du token.
 */
export function renderStaticVerdict(analysis: AnalysisResult, mint: string): string {
  const e = (value: string) => escapeHtml(value);
  const declared = sanitizeUntrustedText(analysis.token.symbol ?? analysis.token.name ?? '', STATIC_TOKEN_MAX);
  const date = new Date(analysis.analyzedAt);
  const valid = !Number.isNaN(date.getTime());
  const lines = [
    `<main data-rj-static="t" class="rj-static" aria-labelledby="rj-static-title">`,
    `  <p class="rj-static__eyebrow">Analyse partagée</p>`,
    `  <h1 id="rj-static-title" class="rj-static__title">Verdict Raijin</h1>`,
    `  <p class="rj-static__verdict" data-verdict="${e(analysis.verdict)}">${e(VERDICT_LABELS[analysis.verdict])}</p>`,
    ...(declared ? [`  <p class="rj-static__token">Symbole déclaré « ${e(declared)} » (non vérifié)</p>`] : []),
    `  <p class="rj-static__explanation">${e(analysis.explanation)}</p>`,
    ...(valid
      ? [`  <p class="rj-static__date">Analyse du <time datetime="${e(date.toISOString())}">${e(STATIC_DATE.format(date))}</time></p>`]
      : []),
    ...(analysis.degraded ? [`  <p class="rj-static__note">Résultat partiel : une source était indisponible.</p>`] : []),
    `  <nav class="rj-static__actions" aria-label="Actions">`,
    `    <a class="rj-static__link" href="/analyse/${e(mint)}">Réanalyser ce token</a>`,
    `    <a class="rj-static__link rj-static__link--primary" href="/analyse">Analyser un autre token</a>`,
    `  </nav>`,
    `  <p class="rj-static__disclaimer" data-disclaimer>${e(ANALYSIS_DISCLAIMER)}</p>`,
    `</main>`,
  ];
  return lines.join('\n');
}

/**
 * Remplace le contenu de la première balise `<rj-root>` (insensible à la casse) par `content`.
 * `null` si la balise est introuvable : la page est alors servie sans verdict statique.
 */
export function injectStaticVerdict(html: string, content: string): string | null {
  const match = /<rj-root\b[^>]*>[\s\S]*?<\/rj-root>/i.exec(html);
  if (!match) return null;
  const openEnd = match[0].indexOf('>') + 1;
  const closeStart = match[0].length - '</rj-root>'.length;
  const replaced = `${match[0].slice(0, openEnd)}${content}${match[0].slice(closeStart)}`;
  // Concaténation plutôt que `String.replace` : `content` pourrait contenir des motifs `$&`.
  return `${html.slice(0, match.index)}${replaced}${html.slice(match.index + match[0].length)}`;
}

/** HTML minimal (sans build web) : lien vers l'app. */
export function minimalHtml(appUrl: string, mint: string | null): string {
  const href = escapeHtml(mint ? `${appUrl}/t/${mint}` : `${appUrl}/analyse`);
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <main>
      <h1>Raijin Shield</h1>
      <p><a href="${href}">Ouvrir l’analyse dans Raijin</a></p>
    </main>
  </body>
</html>
`;
}

/** Retire les balises existantes et insère les nôtres (valeurs échappées) avant `</head>`. */
export function injectMeta(html: string, meta: SharePageMeta): string {
  let output = html;
  for (const pattern of REPLACED_TAGS) output = output.replace(pattern, '');
  const e = (value: string) => escapeHtml(value);
  const tags = [
    `<title>${e(meta.title)}</title>`,
    `<meta name="description" content="${e(meta.description)}" />`,
    `<link rel="canonical" href="${e(meta.canonical)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Raijin Shield" />`,
    `<meta property="og:locale" content="fr_FR" />`,
    `<meta property="og:title" content="${e(meta.title)}" />`,
    `<meta property="og:description" content="${e(meta.description)}" />`,
    `<meta property="og:url" content="${e(meta.canonical)}" />`,
    `<meta property="og:image" content="${e(meta.image)}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="${OG_WIDTH}" />`,
    `<meta property="og:image:height" content="${OG_HEIGHT}" />`,
    `<meta property="og:image:alt" content="${e(meta.imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${e(meta.title)}" />`,
    `<meta name="twitter:description" content="${e(meta.description)}" />`,
    `<meta name="twitter:image" content="${e(meta.image)}" />`,
    `<meta name="twitter:image:alt" content="${e(meta.imageAlt)}" />`,
  ];
  const block = `    ${tags.join('\n    ')}\n  `;
  const index = output.search(/<\/head>/i);
  return `${output.slice(0, index)}${block}${output.slice(index)}`;
}
