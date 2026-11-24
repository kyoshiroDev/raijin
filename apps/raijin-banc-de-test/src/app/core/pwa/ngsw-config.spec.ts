import { describe, expect, it } from 'vitest';
import ngswConfigRaw from '../../../../ngsw-config.json' with { loader: 'text' };
import manifestText from '../../../../public/manifest.webmanifest' with { loader: 'text' };

interface AssetGroup {
  name: string;
  installMode?: string;
  resources: { files?: string[]; urls?: string[] };
}
interface NgswConfig {
  index: string;
  assetGroups?: AssetGroup[];
  dataGroups?: unknown[];
  navigationUrls?: string[];
}

// TypeScript types a .json import as the parsed object; the text loader hands over the raw text.
const ngswConfigText: unknown = ngswConfigRaw;
if (typeof ngswConfigText !== 'string') throw new Error('ngsw-config.json must be imported as text');
const config = JSON.parse(ngswConfigText) as NgswConfig;

describe('ngsw-config.json', () => {
  it('has no dataGroups: API responses are never cached', () => {
    expect(config.dataGroups).toBeUndefined();
  });

  it('never caches the bench API nor any cross-origin URL', () => {
    expect(ngswConfigText).not.toContain('/api');
    for (const group of config.assetGroups ?? []) {
      expect(group.resources.urls ?? []).toEqual([]);
      for (const file of group.resources.files ?? []) expect(file.startsWith('/')).toBe(true);
    }
  });

  it('prefetches the app shell', () => {
    const app = config.assetGroups?.find((g) => g.name === 'app');
    expect(app?.installMode).toBe('prefetch');
    expect(app?.resources.files).toEqual(
      expect.arrayContaining(['/index.html', '/manifest.webmanifest', '/favicon.ico', '/*.css', '/*.js']),
    );
  });

  it('caches the self-hosted fonts (/fonts/**) in a lazy asset group', () => {
    const fonts = config.assetGroups?.find((g) => (g.resources.files ?? []).includes('/fonts/**'));
    expect(fonts).toBeDefined();
    expect(fonts?.installMode).toBe('lazy');
    expect(fonts?.resources.files).toEqual(expect.arrayContaining([expect.stringContaining('woff2')]));
  });

  it('keeps the default navigation URLs (deep links like /token/<mint> get index.html)', () => {
    expect(config.index).toBe('/index.html');
    expect(config.navigationUrls).toBeUndefined();
  });
});

describe('manifest.webmanifest', () => {
  const manifest = JSON.parse(manifestText) as {
    name: string;
    short_name: string;
    display: string;
    start_url: string;
    scope: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };

  it('is the standalone Raijin-banc-de-test app with the dark theme', () => {
    expect(manifest.name).toBe('Raijin-banc-de-test');
    expect(manifest.short_name).toBe('Banc test');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.theme_color).toBe('#07090d');
    expect(manifest.background_color).toBe('#07090d');
  });

  it('declares 192/512 "any" icons and a separate maskable one', () => {
    const any = manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.sizes);
    expect(any).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
  });
});
