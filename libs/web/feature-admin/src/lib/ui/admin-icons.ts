import {
  CalendarRange,
  ChartLine,
  ChevronRight,
  FlaskConical,
  HeartPulse,
  Hourglass,
  LayoutDashboard,
  Lock,
  Megaphone,
  Menu,
  Minus,
  Package,
  Receipt,
  Search,
  ShieldCheck,
  Table2,
  TrendingDown,
  TrendingUp,
  Unplug,
  Users,
  type IconNode,
} from 'lucide';

/**
 * Icônes propres à l'espace admin (Lucide, ISC), passées telles quelles à `<rj-icon [name]>` : elles restent
 * dans le chunk admin (le registre `RjIcons` de web-ui est chargé au démarrage de l'app).
 */
export const AdminIcons = {
  overview: LayoutDashboard,
  traffic: ChartLine,
  seo: Search,
  acquisition: Megaphone,
  revenue: Receipt,
  trials: Hourglass,
  users: Users,
  product: Package,
  health: HeartPulse,
  up: TrendingUp,
  down: TrendingDown,
  flat: Minus,
  menu: Menu,
  notConnected: Unplug,
  simulated: FlaskConical,
  table: Table2,
  chevronRight: ChevronRight,
  lock: Lock,
  period: CalendarRange,
  shield: ShieldCheck,
} as const satisfies Record<string, IconNode>;

export type AdminIconName = keyof typeof AdminIcons;
