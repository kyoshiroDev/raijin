import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  model,
  viewChild,
} from '@angular/core';
import { Icon } from './icon';

let nextId = 0;
/** Open sheets (a sheet can open another one, e.g. the paper trade sheet from the token sheet). */
let openCount = 0;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Opening animation (220 ms) plus margin. */
const SETTLE_MS = 500;

export type SheetLayout = 'bottom' | 'responsive';

const LAYOUT_CLASS: Record<SheetLayout, string> = {
  bottom: 'max-w-lg',
  // Mobile: definite height (a content-sized column flex panel can collapse on iOS Safari); md: side panel.
  responsive:
    'h-[88dvh] md:h-auto md:inset-y-0 md:right-0 md:left-auto md:mx-0 md:max-h-none md:w-[26rem] md:animate-panel-in md:rounded-none md:border-y-0 md:border-r-0 md:safe-top md:motion-reduce:animate-none',
};

/**
 * Modal sheet built on the native <dialog>.
 * - `bottom`: slides up from the bottom at every width (centred, max 32rem on desktop).
 * - `responsive`: bottom sheet on mobile, side panel on the right from `md`.
 * Escape and a tap on the backdrop close it; focus moves into the panel, is trapped while open,
 * and returns to the element that had it before opening. Page scroll is locked while open.
 */
@Component({
  selector: 'app-sheet',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      role="dialog"
      aria-modal="true"
      [attr.aria-labelledby]="titleId"
      class="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0 text-fg"
      (click)="onClick($event)"
      (keydown)="onKeydown($event)"
      (cancel)="onCancel($event)"
      (scroll)="onDialogScroll()"
    >
      <div data-sheet-backdrop class="absolute inset-0 animate-fade-in bg-base/70 backdrop-blur-[2px] motion-reduce:animate-none"></div>
      <div
        #panel
        tabindex="-1"
        class="absolute inset-x-0 bottom-0 mx-auto flex max-h-[88dvh] w-full flex-col rounded-t-2xl border border-b-0 border-line bg-surface shadow-2xl safe-x animate-sheet-up focus:outline-none motion-reduce:animate-none"
        [class]="layoutClass()"
      >
        <div class="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" [class]="handleClass()" aria-hidden="true"></div>
        <header class="flex shrink-0 items-center gap-2 border-b border-line py-1 pr-1 pl-4">
          <h2 [id]="titleId" class="min-w-0 flex-1 truncate text-base font-bold">{{ heading() }}</h2>
          <button type="button" class="btn size-11 shrink-0 px-0 text-muted hover:text-fg" aria-label="Fermer" (click)="close()">
            <app-icon name="close" class="size-5" />
          </button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <ng-content />
        </div>
      </div>
    </dialog>
  `,
})
export class Sheet {
  readonly open = model(false);
  readonly heading = input.required<string>();
  readonly layout = input<SheetLayout>('bottom');

  protected readonly layoutClass = computed(() => LAYOUT_CLASS[this.layout()]);
  protected readonly handleClass = computed(() => (this.layout() === 'responsive' ? 'md:hidden' : ''));
  protected readonly titleId = `sheet-title-${++nextId}`;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private readonly document = inject(DOCUMENT);
  private returnFocus: HTMLElement | null = null;
  private shown = false;
  /** End of the opening animation window (epoch ms) during which the dialog scroll is forced back to 0. */
  private settleUntil = 0;

  constructor() {
    afterRenderEffect(() => {
      if (this.open()) this.show();
      else this.hide(true);
    });
    inject(DestroyRef).onDestroy(() => this.hide(false));
  }

  close(): void {
    this.open.set(false);
  }

  protected onClick(event: MouseEvent): void {
    // Anything outside the panel is the backdrop.
    const target = event.target;
    if (target instanceof Node && !this.panel().nativeElement.contains(target)) this.close();
  }

  /**
   * The dialog itself must never scroll. iOS Safari scrolls the overflow-hidden dialog to reveal the focused panel
   * while it is still translated below the screen by the slide-up animation, which leaves the sheet shifted up.
   */
  protected onDialogScroll(): void {
    // Only while the panel slides in: afterwards iOS may legitimately scroll to keep a focused field above the keyboard.
    if (Date.now() < this.settleUntil) this.resetDialogScroll();
  }

  private resetDialogScroll(): void {
    const dialog = this.dialog().nativeElement;
    if (dialog.scrollTop !== 0) dialog.scrollTop = 0;
    if (dialog.scrollLeft !== 0) dialog.scrollLeft = 0;
  }

  protected onCancel(event: Event): void {
    event.preventDefault(); // we close through the model so the parent state stays in sync
    this.close();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    } else if (event.key === 'Tab') {
      event.stopPropagation(); // a parent sheet must not trap focus again
      this.trapFocus(event);
    }
  }

  private show(): void {
    if (this.shown) return;
    this.shown = true;
    const active = this.document.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    const dialog = this.dialog().nativeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', ''); // jsdom / very old engines
    openCount++;
    this.document.documentElement.classList.add('scroll-locked');
    this.settleUntil = Date.now() + SETTLE_MS;
    this.panel().nativeElement.focus({ preventScroll: true });
    this.resetDialogScroll();
  }

  private hide(restoreFocus: boolean): void {
    if (!this.shown) return;
    this.shown = false;
    const dialog = this.dialog().nativeElement;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    dialog.removeAttribute('open');
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) this.document.documentElement.classList.remove('scroll-locked');
    const target = this.returnFocus;
    this.returnFocus = null;
    if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
  }

  private trapFocus(event: KeyboardEvent): void {
    const panel = this.panel().nativeElement;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
