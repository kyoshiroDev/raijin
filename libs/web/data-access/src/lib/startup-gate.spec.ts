import { STARTUP_GATE_EVENTS, shouldDeferStartup, startWhenInteractive } from './startup-gate';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const STATIC_HTML = '<rj-root><main data-rj-static="t" class="rj-static"><h1>Verdict Raijin</h1></main></rj-root>';

/** Vue de test : le document jsdom courant et une `location` contrôlée. */
function view(pathname: string, search = ''): Window {
  return { document, location: { pathname, search } } as unknown as Window;
}

describe('startWhenInteractive', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('démarre tout de suite hors de /t', () => {
    document.body.innerHTML = STATIC_HTML;
    const start = vi.fn();
    startWhenInteractive(start, view('/analyse'));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('démarre tout de suite sur /t sans verdict statique injecté', () => {
    document.body.innerHTML = '<rj-root></rj-root>';
    const start = vi.fn();
    startWhenInteractive(start, view(`/t/${BONK}`));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('démarre tout de suite avec des paramètres utm_*', () => {
    document.body.innerHTML = STATIC_HTML;
    const start = vi.fn();
    startWhenInteractive(start, view(`/t/${BONK}`, '?utm_source=x'));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('démarre tout de suite sans fenêtre', () => {
    const start = vi.fn();
    startWhenInteractive(start, null);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('ignore un verdict statique hors de <rj-root>', () => {
    document.body.innerHTML = '<main data-rj-static="t"></main><rj-root></rj-root>';
    expect(shouldDeferStartup({ pathname: `/t/${BONK}`, search: '' }, document)).toBe(false);
  });

  it('refuse un chemin /t sans adresse valide', () => {
    document.body.innerHTML = STATIC_HTML;
    expect(shouldDeferStartup({ pathname: '/t/abc', search: '' }, document)).toBe(false);
    expect(shouldDeferStartup({ pathname: `/t/${BONK}/`, search: '' }, document)).toBe(true);
  });

  it.each(STARTUP_GATE_EVENTS)('attend puis démarre une seule fois au premier %s', (type) => {
    document.body.innerHTML = STATIC_HTML;
    const start = vi.fn();
    startWhenInteractive(start, view(`/t/${BONK}`));
    document.dispatchEvent(new Event('scroll'));
    expect(start).not.toHaveBeenCalled();

    document.dispatchEvent(new Event(type, { bubbles: true }));
    expect(start).toHaveBeenCalledTimes(1);

    for (const other of STARTUP_GATE_EVENTS) document.dispatchEvent(new Event(other, { bubbles: true }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('retire tous les écouteurs au premier déclenchement', () => {
    document.body.innerHTML = STATIC_HTML;
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    startWhenInteractive(vi.fn(), view(`/t/${BONK}`));
    expect(add.mock.calls.map(([type]) => type)).toEqual([...STARTUP_GATE_EVENTS]);
    for (const [, , options] of add.mock.calls) {
      expect(options).toEqual({ capture: true, passive: true, once: true });
    }

    document.dispatchEvent(new Event('keydown'));
    expect(remove.mock.calls.map(([type]) => type)).toEqual([...STARTUP_GATE_EVENTS]);
    for (const [index, [, listener]] of remove.mock.calls.entries()) {
      expect(listener).toBe(add.mock.calls[index]?.[1]);
    }
  });
});
