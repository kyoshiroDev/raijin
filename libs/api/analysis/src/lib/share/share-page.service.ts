import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, errorCode, GLOBAL_PREFIX, type AppConfig } from '@raijin/api-core';
import { ANALYSIS_DISCLAIMER, VERDICT_LABELS, type AnalysisResult } from '@raijin/shared-contracts';
import { truncateMiddle } from '@raijin/shared-util';
import { readFile } from 'node:fs/promises';
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
  private template: Promise<string> | null = null;

  constructor(
    private readonly analyses: AnalysisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** HTML de la page publique d'un mint (`null` : mint invalide, page générique). */
  async render(mint: string | null): Promise<string> {
    const analysis = mint ? await this.analyses.findLatest(mint) : null;
    return injectMeta(await this.loadTemplate(mint), this.meta(mint, analysis));
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

  private loadTemplate(mint: string | null): Promise<string> {
    const path = this.config.analysis.webIndexHtmlPath;
    if (!path) return Promise.resolve(minimalHtml(this.config.appUrl, mint));
    if (!this.template) {
      this.template = readFile(path, 'utf8').catch((error: unknown) => {
        this.logger.warn(`index.html du build web illisible, HTML minimal servi (${errorCode(error)})`);
        this.template = null;
        return '';
      });
    }
    return this.template.then((html) => (html.includes('</head>') ? html : minimalHtml(this.config.appUrl, mint)));
  }
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
