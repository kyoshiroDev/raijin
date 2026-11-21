import {
  Bell,
  Check,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  Copy,
  Eye,
  Info,
  LoaderCircle,
  OctagonX,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  TriangleAlert,
  User,
  Wallet,
  X,
  type IconNode,
} from 'lucide';

export type { IconNode };

/**
 * Icônes Lucide retenues par Raijin (ISC). Import nommé : seules ces icônes finissent dans le bundle.
 * Icônes de verdict imposées par la charte : bouclier-check, triangle, octogone-croix.
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
  collapse: PanelLeftClose,
  expand: PanelLeftOpen,
  safe: ShieldCheck,
  warn: TriangleAlert,
  danger: OctagonX,
} as const satisfies Record<string, IconNode>;

export type RjIconName = keyof typeof RjIcons;
