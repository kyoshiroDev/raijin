import { ANALYSIS_DISCLAIMER, VERDICT_LABELS, type AnalysisResult, type Verdict } from '@raijin/shared-contracts';
import { sanitizeUntrustedText, truncateMiddle } from '@raijin/shared-util';
import { OG_COLORS, RAI_ALERT_SVG, RAI_HERO_SVG, RAIJIN_MARK_SVG } from './brand-assets';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
/** Longueur maximale du nom du token dans l'image (caractères). */
export const OG_NAME_MAX_LENGTH = 24;
const PADDING_X = 64;
const PADDING_Y = 56;

/** Nœud satori minimal (objets simples, aucun HTML parsé). */
export interface OgNode {
  type: string;
  props: { style?: Record<string, string | number>; children?: OgNode | string | (OgNode | string)[]; src?: string; width?: number; height?: number };
}

/** Données affichées : rien d'autre que le verdict, le mint et un nom nettoyé. */
export interface OgModel {
  readonly verdict: Verdict | null;
  readonly mint: string | null;
  readonly name: string | null;
}

/**
 * Nom du token pour l'image : texte non fiable nettoyé (`sanitizeUntrustedText`), réduit aux
 * caractères latins imprimables couverts par les polices embarquées, puis tronqué.
 * Renvoie `null` s'il ne reste rien.
 */
export function cleanNameForImage(raw: string | null): string | null {
  if (!raw) return null;
  const latin = sanitizeUntrustedText(raw, 64)
    .replace(/[^\u0020-\u007E\u00A0-\u00FF\u2019]/g, '')
    .replace(/[<>"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!latin) return null;
  const chars = Array.from(latin);
  return chars.length > OG_NAME_MAX_LENGTH ? `${chars.slice(0, OG_NAME_MAX_LENGTH - 1).join('').trimEnd()}…` : latin;
}

export function ogModelFrom(result: AnalysisResult | null): OgModel {
  if (!result) return { verdict: null, mint: null, name: null };
  return { verdict: result.verdict, mint: result.mint, name: cleanNameForImage(result.token.name ?? result.token.symbol) };
}

/** Icônes de verdict de la charte (Lucide, trait 1,75 px) : bouclier-check, triangle, octogone-croix. */
const VERDICT_ICON_PATHS: Readonly<Record<Verdict, string>> = {
  safe: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  danger:
    '<path d="m15 9-6 6"/><path d="M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z"/><path d="m9 9 6 6"/>',
};

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function verdictIcon(verdict: Verdict): string {
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${OG_COLORS[verdict]}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${VERDICT_ICON_PATHS[verdict]}</svg>`,
  );
}

function node(type: string, style: Record<string, string | number>, children?: OgNode['props']['children']): OgNode {
  return { type, props: children === undefined ? { style } : { style, children } };
}

function img(src: string, width: number, height: number, style: Record<string, string | number> = {}): OgNode {
  return { type: 'img', props: { src, width, height, style: { width, height, ...style } } };
}

/** Arbre satori de l'image 1200×630 (fond `base`, logo, verdict icône + mot, mint, petit Rai). */
export function buildOgTree(model: OgModel): OgNode {
  const verdictBlock: OgNode = model.verdict
    ? node(
        'div',
        {
          display: 'flex',
          alignItems: 'center',
          gap: 28,
          padding: '20px 36px',
          borderRadius: 16,
          border: `4px solid ${OG_COLORS[model.verdict]}`,
          backgroundColor: OG_COLORS.surface,
        },
        [
          img(verdictIcon(model.verdict), 96, 96),
          node('div', { display: 'flex', fontFamily: 'Space Grotesk', fontSize: 104, fontWeight: 700, color: OG_COLORS[model.verdict] }, VERDICT_LABELS[model.verdict]),
        ],
      )
    : node('div', { display: 'flex', fontFamily: 'Space Grotesk', fontSize: 72, fontWeight: 700, color: OG_COLORS.ink }, 'Vérifie avant de signer');

  const details: OgNode[] = [];
  if (model.name) {
    details.push(
      node('div', { display: 'flex', fontFamily: 'Inter', fontSize: 34, color: OG_COLORS.ink }, `Nom déclaré : « ${model.name} » (non vérifié)`),
    );
  }
  if (model.mint) {
    details.push(node('div', { display: 'flex', fontFamily: 'JetBrains Mono', fontSize: 32, color: OG_COLORS['ink-muted'] }, truncateMiddle(model.mint, 6, 6)));
  }
  if (!model.verdict) {
    details.push(
      node('div', { display: 'flex', fontFamily: 'Inter', fontSize: 34, color: OG_COLORS['ink-muted'] }, 'Analyse anti-rug des tokens Solana, en lecture seule.'),
    );
  }

  // Dimensions explicites (sans padding sur les conteneurs dimensionnés : satori les ajouterait à la taille).
  const content = node(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      width: OG_WIDTH - 2 * PADDING_X,
      height: OG_HEIGHT - 2 * PADDING_Y,
      marginLeft: PADDING_X,
      marginTop: PADDING_Y,
    },
    [
      node('div', { display: 'flex', alignItems: 'center', gap: 20 }, [
        img(svgDataUri(RAIJIN_MARK_SVG), 72, 72),
        node('div', { display: 'flex', fontFamily: 'Space Grotesk', fontSize: 44, fontWeight: 700, color: OG_COLORS.ink }, 'Raijin Shield'),
      ]),
      node('div', { display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 860 }, [verdictBlock, ...details]),
      node('div', { display: 'flex', fontFamily: 'Inter', fontSize: 24, color: OG_COLORS['ink-muted'], maxWidth: 820 }, ANALYSIS_DISCLAIMER),
    ],
  );

  return node('div', { display: 'flex', width: OG_WIDTH, height: OG_HEIGHT, backgroundColor: OG_COLORS.base, position: 'relative' }, [
    content,
    img(svgDataUri(model.verdict === 'warn' || model.verdict === 'danger' ? RAI_ALERT_SVG : RAI_HERO_SVG), 216, 252, {
      position: 'absolute',
      right: 56,
      bottom: 40,
    }),
  ]);
}
