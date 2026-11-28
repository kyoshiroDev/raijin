import type { IconNode } from 'lucide';

/*
 * Tracés Lucide (ISC, https://lucide.dev) des icônes du bundle initial, recopiés tels quels : importés du paquet,
 * ils partageaient un chunk avec les icônes des écrans à la demande, que l'optimiseur de chunks remontait alors
 * dans le bundle initial (docs/ARCHITECTURE.md §10.6, G2). Égalité avec `lucide` vérifiée par icon.spec.ts.
 */
const Bell: IconNode = [
  ['path', { d: 'M10.268 21a2 2 0 0 0 3.464 0' }],
  [
    'path',
    {
      d: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326',
    },
  ],
];
const BookmarkPlus: IconNode = [
  ['path', { d: 'M12 7v6' }],
  ['path', { d: 'M15 10H9' }],
  [
    'path',
    {
      d: 'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z',
    },
  ],
];
const ChevronDown: IconNode = [['path', { d: 'm6 9 6 6 6-6' }]];
const Check: IconNode = [['path', { d: 'M20 6 9 17l-5-5' }]];
const CircleAlert: IconNode = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['line', { x1: '12', x2: '12', y1: '8', y2: '12' }],
  ['line', { x1: '12', x2: '12.01', y1: '16', y2: '16' }],
];
const CircleCheck: IconNode = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'm16 9-5.5 5.5L8 12' }],
];
const CircleDashed: IconNode = [
  ['path', { d: 'M10.1 2.182a10 10 0 0 1 3.8 0' }],
  ['path', { d: 'M13.9 21.818a10 10 0 0 1-3.8 0' }],
  ['path', { d: 'M17.609 3.721a10 10 0 0 1 2.69 2.7' }],
  ['path', { d: 'M2.182 13.9a10 10 0 0 1 0-3.8' }],
  ['path', { d: 'M20.279 17.609a10 10 0 0 1-2.7 2.69' }],
  ['path', { d: 'M21.818 10.1a10 10 0 0 1 0 3.8' }],
  ['path', { d: 'M3.721 6.391a10 10 0 0 1 2.7-2.69' }],
  ['path', { d: 'M6.391 20.279a10 10 0 0 1-2.69-2.7' }],
];
const CircleHelp: IconNode = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'M9 9.5a3 2.5 0 016 0c0 2-2 2-3 3.5' }],
  ['path', { d: 'M12 17h.01' }],
];
const Clock: IconNode = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'M12 6v6l4 2' }],
];
const ClipboardPaste: IconNode = [
  ['path', { d: 'M11 14h10' }],
  ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v1.344' }],
  ['path', { d: 'm17 18 4-4-4-4' }],
  [
    'path',
    { d: 'M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113' },
  ],
  ['rect', { x: '8', y: '2', width: '8', height: '4', rx: '1' }],
];
const Copy: IconNode = [
  ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
  ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
];
const Eye: IconNode = [
  [
    'path',
    {
      d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0',
    },
  ],
  ['circle', { cx: '12', cy: '12', r: '3' }],
];
const EyeOff: IconNode = [
  [
    'path',
    {
      d: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49',
    },
  ],
  ['path', { d: 'M14.084 14.158a3 3 0 0 1-4.242-4.242' }],
  [
    'path',
    {
      d: 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143',
    },
  ],
  ['path', { d: 'm2 2 20 20' }],
];
const ExternalLink: IconNode = [
  ['path', { d: 'M15 3h6v6' }],
  ['path', { d: 'M10 14 21 3' }],
  ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
];
const Info: IconNode = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'M12 16v-4' }],
  ['path', { d: 'M12 8h.01' }],
];
const KeyRound: IconNode = [
  [
    'path',
    {
      d: 'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z',
    },
  ],
  ['circle', { cx: '16.5', cy: '7.5', r: '.5', fill: 'currentColor' }],
];
const LoaderCircle: IconNode = [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]];
const Mail: IconNode = [
  ['path', { d: 'm22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7' }],
  ['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }],
];
const OctagonX: IconNode = [
  ['path', { d: 'm15 9-6 6' }],
  [
    'path',
    {
      d: 'M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z',
    },
  ],
  ['path', { d: 'm9 9 6 6' }],
];
const RefreshCw: IconNode = [
  ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
  ['path', { d: 'M21 3v5h-5' }],
  ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
  ['path', { d: 'M8 16H3v5' }],
];
const ScanSearch: IconNode = [
  ['path', { d: 'M3 7V5a2 2 0 0 1 2-2h2' }],
  ['path', { d: 'M17 3h2a2 2 0 0 1 2 2v2' }],
  ['path', { d: 'M21 17v2a2 2 0 0 1-2 2h-2' }],
  ['path', { d: 'M7 21H5a2 2 0 0 1-2-2v-2' }],
  ['circle', { cx: '12', cy: '12', r: '3' }],
  ['path', { d: 'm16 16-1.9-1.9' }],
];
const Share2: IconNode = [
  ['circle', { cx: '18', cy: '5', r: '3' }],
  ['circle', { cx: '6', cy: '12', r: '3' }],
  ['circle', { cx: '18', cy: '19', r: '3' }],
  ['line', { x1: '8.59', x2: '15.42', y1: '13.51', y2: '17.49' }],
  ['line', { x1: '15.41', x2: '8.59', y1: '6.51', y2: '10.49' }],
];
const ShieldCheck: IconNode = [
  [
    'path',
    {
      d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    },
  ],
  ['path', { d: 'm9 12 2 2 4-4' }],
];
const TriangleAlert: IconNode = [
  [
    'path',
    {
      d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    },
  ],
  ['path', { d: 'M12 9v4' }],
  ['path', { d: 'M12 17h.01' }],
];
const User: IconNode = [
  ['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }],
  ['circle', { cx: '12', cy: '7', r: '4' }],
];
const Wallet: IconNode = [
  [
    'path',
    {
      d: 'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1',
    },
  ],
  ['path', { d: 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4' }],
];
const X: IconNode = [
  ['path', { d: 'M18 6 6 18' }],
  ['path', { d: 'm6 6 12 12' }],
];
const BellOff: IconNode = [
  ['path', { d: 'M10.268 21a2 2 0 0 0 3.464 0' }],
  [
    'path',
    {
      d: 'M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742',
    },
  ],
  ['path', { d: 'm2 2 20 20' }],
  ['path', { d: 'M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05' }],
];
const BookmarkCheck: IconNode = [
  [
    'path',
    {
      d: 'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z',
    },
  ],
  ['path', { d: 'm9 10 2 2 4-4' }],
];

export type { IconNode };

/**
 * Icônes Lucide retenues par Raijin (ISC). Import nommé : seules ces icônes finissent dans le bundle.
 * Icônes de verdict imposées par la charte : bouclier-check, triangle, octogone-croix.
 *
 * Registre scindé (docs/ARCHITECTURE.md §10.6, G2) : ici, les icônes de la coquille, de `/analyse` et de
 * `/t` (bundle initial) ; les autres sont dans `icons-extra.ts`, chargé à la demande par `RjIcon`.
 */
export const RjIcons = {
  analyse: ScanSearch,
  suivis: Eye,
  alertes: Bell,
  compte: User,
  wallet: Wallet,
  bell: Bell,
  check: Check,
  circleCheck: CircleCheck,
  circleAlert: CircleAlert,
  copy: Copy,
  paste: ClipboardPaste,
  info: Info,
  loader: LoaderCircle,
  close: X,
  retry: RefreshCw,
  safe: ShieldCheck,
  warn: TriangleAlert,
  danger: OctagonX,
  eye: Eye,
  eyeOff: EyeOff,
  mail: Mail,
  key: KeyRound,
  chevronDown: ChevronDown,
  external: ExternalLink,
  share: Share2,
  help: CircleHelp,
  unavailable: CircleDashed,
  follow: BookmarkPlus,
  clock: Clock,
  following: BookmarkCheck,
  bellOff: BellOff,
} as const satisfies Record<string, IconNode>;

/** Icônes des écrans chargés à la demande (compte, suivis, wallet) : `icons-extra.ts`. */
export type RjExtraIconName = keyof typeof import('./icons-extra').RjExtraIcons;

export type RjIconName = keyof typeof RjIcons | RjExtraIconName;

/** Vrai si l'icône est dans le registre du bundle initial. */
export function isCoreIcon(name: string): name is keyof typeof RjIcons {
  return Object.prototype.hasOwnProperty.call(RjIcons, name);
}
