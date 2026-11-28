import { brandColors } from './colors';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Nœud satori minimal (objets simples, aucun HTML parsé). */
export interface OgNode {
  type: string;
  props: {
    style?: Record<string, string | number>;
    children?: OgNode | string | (OgNode | string)[];
    src?: string;
    width?: number;
    height?: number;
  };
}

export interface OgPage {
  /** Libellé au-dessus du titre (« Guide », « Tarifs »…). */
  readonly kicker: string;
  readonly title: string;
  readonly subtitle: string;
}

export interface OgAssets {
  readonly markSvg: string;
  readonly raiSvg: string;
}

function dataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function node(type: string, style: Record<string, string | number>, children?: OgNode['props']['children']): OgNode {
  return { type, props: children === undefined ? { style } : { style, children } };
}

function img(src: string, width: number, height: number, style: Record<string, string | number> = {}): OgNode {
  return { type: 'img', props: { src, width, height, style: { width, height, ...style } } };
}

/** Image 1200 × 630 : fond `base`, logo et nom officiel, titre de la page, Rai en pose héros, liseré `thunder`. */
export function buildOgTree(page: OgPage, assets: OgAssets): OgNode {
  const c = brandColors();
  const padX = 72;
  const padY = 64;
  const content = node(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      width: 820,
      height: OG_HEIGHT - 2 * padY,
      marginLeft: padX,
      marginTop: padY,
    },
    [
      node('div', { display: 'flex', alignItems: 'center', gap: 18 }, [
        img(dataUri(assets.markSvg), 64, 64),
        node('div', { display: 'flex', fontFamily: 'Space Grotesk', fontSize: 40, fontWeight: 700, color: c.ink }, 'Raijin Shield'),
      ]),
      node('div', { display: 'flex', flexDirection: 'column', gap: 20 }, [
        node(
          'div',
          { display: 'flex', fontFamily: 'Inter', fontSize: 26, color: c.thunder, letterSpacing: 2, textTransform: 'uppercase' },
          page.kicker,
        ),
        node('div', { display: 'flex', fontFamily: 'Space Grotesk', fontSize: 68, fontWeight: 700, color: c.ink, lineHeight: 1.08 }, page.title),
        node('div', { display: 'flex', fontFamily: 'Inter', fontSize: 30, color: c['ink-muted'], lineHeight: 1.35 }, page.subtitle),
      ]),
      node('div', { display: 'flex', fontFamily: 'Inter', fontSize: 22, color: c['ink-muted'] }, 'raijinshield.com · lecture seule, pas un conseil en investissement'),
    ],
  );
  return node('div', { display: 'flex', width: OG_WIDTH, height: OG_HEIGHT, backgroundColor: c.base, position: 'relative' }, [
    node('div', { display: 'flex', position: 'absolute', left: 0, top: 0, width: 12, height: OG_HEIGHT, backgroundColor: c.thunder }),
    content,
    img(dataUri(assets.raiSvg), 240, 280, { position: 'absolute', right: 64, bottom: 60 }),
  ]);
}
