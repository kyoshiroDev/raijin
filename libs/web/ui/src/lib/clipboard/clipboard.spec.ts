import { TestBed } from '@angular/core/testing';
import { RjClipboard } from './clipboard';

describe('RjClipboard', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  function mockClipboard(value: Partial<Clipboard> | undefined) {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  }

  afterEach(() => {
    if (original) {
      Object.defineProperty(navigator, 'clipboard', original);
    } else {
      delete (navigator as { clipboard?: Clipboard }).clipboard;
    }
  });

  it('lit le presse-papiers via la Clipboard API', async () => {
    mockClipboard({ readText: vi.fn(async () => 'abc') });
    expect(await TestBed.inject(RjClipboard).read()).toBe('abc');
  });

  it('renvoie null si la lecture est refusée ou absente', async () => {
    mockClipboard({ readText: vi.fn(async () => Promise.reject(new DOMException('refus', 'NotAllowedError'))) });
    expect(await TestBed.inject(RjClipboard).read()).toBeNull();
    mockClipboard(undefined);
    expect(await TestBed.inject(RjClipboard).read()).toBeNull();
  });

  it('copie via writeText, sinon via le repli execCommand', async () => {
    const writeText = vi.fn(async () => undefined);
    mockClipboard({ writeText });
    const clipboard = TestBed.inject(RjClipboard);
    expect(await clipboard.copy('abc')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('abc');

    mockClipboard({ writeText: vi.fn(async () => Promise.reject(new Error('refus'))) });
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: (cmd: string) => boolean }).execCommand = exec;
    expect(await clipboard.copy('abc')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });
});
