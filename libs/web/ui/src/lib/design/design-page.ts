import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RjAddressChip } from '../address-chip/address-chip';
import { RjBottomSheet } from '../bottom-sheet/bottom-sheet';
import { RjButton } from '../button/button';
import { RjCard } from '../card/card';
import { RjCheckbox } from '../checkbox/checkbox';
import { RjInputField } from '../input-field/input-field';
import { RjLogo } from '../logo/logo';
import { type RjNavItem } from '../navigation/nav-item';
import { RjSidebar } from '../navigation/sidebar';
import { RjTabBar } from '../navigation/tab-bar';
import { RjSkeleton } from '../skeleton/skeleton';
import { RjEmptyState } from '../states/empty-state';
import { RjErrorState } from '../states/error-state';
import { RjToastItem } from '../toast/toast';
import { RjToastService } from '../toast/toast.service';
import { RjVerdictBadge, type RjVerdict } from '../verdict-badge/verdict-badge';

interface DemoToken {
  readonly mint: string;
  readonly name: string;
  readonly verdict: RjVerdict;
  readonly facts: readonly string[];
}

/**
 * Page `/_design` (dev uniquement) : référence visuelle de tous les composants de base
 * dans tous leurs états, support des captures Playwright (320 → 1920 px).
 */
@Component({
  selector: 'rj-design-page',
  imports: [
    RjAddressChip,
    RjBottomSheet,
    RjButton,
    RjCard,
    RjCheckbox,
    RjInputField,
    RjLogo,
    RjSidebar,
    RjTabBar,
    RjSkeleton,
    RjEmptyState,
    RjErrorState,
    RjToastItem,
    RjVerdictBadge,
  ],
  templateUrl: './design-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DesignPage {
  private readonly toasts = inject(RjToastService);

  protected readonly sampleMint = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  protected readonly address = signal('');
  protected readonly filledAddress = signal('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  protected readonly invalidAddress = signal('7xKX-pas-une-adresse');
  protected readonly modalOpen = signal(false);
  protected readonly panelOpen = signal(false);
  protected readonly sidebarCollapsed = signal(true);

  protected readonly navItems: readonly RjNavItem[] = [
    { label: 'Analyser', path: '/analyse', icon: 'analyse' },
    { label: 'Suivis', path: '/suivis', icon: 'suivis' },
    { label: 'Alertes', path: '/alertes', icon: 'alertes', badge: 3 },
    { label: 'Compte', path: '/compte', icon: 'compte' },
  ];
  protected readonly secondaryNav: readonly RjNavItem[] = [{ label: 'Scan de wallet', path: '/wallet', icon: 'wallet' }];

  protected readonly swatches = [
    { name: 'base', className: 'bg-base' },
    { name: 'surface', className: 'bg-surface' },
    { name: 'surface-raised', className: 'bg-surface-raised' },
    { name: 'line', className: 'bg-line' },
    { name: 'thunder', className: 'bg-thunder' },
    { name: 'safe', className: 'bg-safe' },
    { name: 'warn', className: 'bg-warn' },
    { name: 'danger', className: 'bg-danger' },
    { name: 'info', className: 'bg-info' },
    { name: 'ink-muted', className: 'bg-ink-muted' },
  ] as const;

  protected readonly tokens: readonly DemoToken[] = [
    {
      mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      name: 'Exemple A',
      verdict: 'safe',
      facts: ['Mint désactivé', 'LP verrouillée 92 %'],
    },
    {
      mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
      name: 'Exemple B au nom nettement plus long que les autres',
      verdict: 'warn',
      facts: ['62 % de l’offre dans 5 wallets', 'LP verrouillée 40 %', 'Création il y a 3 h'],
    },
    {
      mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
      name: 'Exemple C',
      verdict: 'danger',
      facts: ['Autorité de mint encore active'],
    },
  ];

  protected toast(tone: 'info' | 'success' | 'error'): void {
    const messages = {
      info: 'Analyse lancée : Raijin vérifie le mint, la LP et les holders.',
      success: 'Token ajouté à tes suivis.',
      error: 'Analyse impossible pour l’instant. Réessaie dans un moment.',
    } as const;
    this.toasts.show(messages[tone], { tone });
  }
}
