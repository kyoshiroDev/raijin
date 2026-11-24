import {
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  Download,
  LogOut,
  MailCheck,
  Pause,
  Play,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  WifiOff,
  type IconNode,
} from 'lucide';

/**
 * Icônes des écrans chargés à la demande (compte, abonnement, suivis, alertes, wallet).
 * Chunk séparé, importé dynamiquement par `RjIcon` à la première icône absente du registre initial
 * (docs/ARCHITECTURE.md §10.6, G2). Ne pas importer statiquement depuis le bundle initial.
 */
export const RjExtraIcons = {
  mailCheck: MailCheck,
  logout: LogOut,
  download: Download,
  trash: Trash2,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  pause: Pause,
  play: Play,
  filter: SlidersHorizontal,
  checkAll: CheckCheck,
  smartphone: Smartphone,
  wifiOff: WifiOff,
} as const satisfies Record<string, IconNode>;
