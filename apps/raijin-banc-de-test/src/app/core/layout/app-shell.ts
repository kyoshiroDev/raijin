import { ChangeDetectionStrategy, Component, DestroyRef, type OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MarketContext } from '../market/market-context';
import { UserPreferences } from '../preferences/user-preferences';
import { BottomNav } from './bottom-nav';

/** Layout of every signed-in page: routed content + fixed bottom tab bar. */
@Component({
  selector: 'app-shell',
  imports: [BottomNav, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-h-dvh pb-tabbar' },
  template: `
    <router-outlet />
    <app-bottom-nav />
  `,
})
export class AppShell implements OnInit {
  private readonly preferences = inject(UserPreferences);
  private readonly market = inject(MarketContext);

  constructor() {
    // Leaving the signed-in area (sign-out): forget the previous user's preferences and rates.
    inject(DestroyRef).onDestroy(() => {
      this.preferences.reset();
      this.market.reset();
    });
  }

  ngOnInit(): void {
    void this.preferences.load();
    // SOL → € rate from the latest scan run (once per session, cached 5 min). Never blocks the UI.
    void this.market.load();
  }
}
