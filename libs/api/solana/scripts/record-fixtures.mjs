#!/usr/bin/env node
/**
 * Enregistrement manuel des fixtures de `api-solana` (ARCHITECTURE.md §9.9).
 *
 *   pnpm nx run api-solana:record-fixtures
 *
 * - Appelle uniquement des API publiques en lecture (RPC Solana, DexScreener, GeckoTerminal,
 *   Jupiter quote = DEVIS seulement, RugCheck), en respectant leurs limites de débit.
 * - Helius (DAS) n'est appelé que si HELIUS_API_KEY est présent dans l'environnement du processus ;
 *   la clé n'est jamais affichée ni écrite : le fichier ne contient ni URL complète ni en-tête.
 * - Jamais lancé en CI ni mis en cache (cible Nx `cache: false`).
 *
 * Format : { recordedAt, source, request: { method, path | rpcMethod, params }, status, body }.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'fixtures');
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const HELIUS_KEY = (process.env.HELIUS_API_KEY ?? '').trim();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';

/** Tokens représentatifs (adresses publiques). */
const TOKENS = {
  bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  usdc: USDC,
  pyusd: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  'fresh-pump': '9rA3rJrcFJeQwWaLaHgJLi4LaF6wvRoae9ybwcYApump',
  'mint-active': 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi',
  honeypot: '3Ss6A75uZG9cSRt4feyhcmJVGT38USeygDfwi1tBGQVa',
};
const MISSING_MINT = 'Y3Pg4fGfK1jz4exHgF2duMUhZvjAa1FdBuJYMsyZfWD';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `--source=dexscreener` : n'enregistre qu'une source ; arguments libres = noms de tokens. */
const SOURCE_ARG = process.argv.find((arg) => arg.startsWith('--source='))?.slice('--source='.length) ?? null;
const wants = (source) => SOURCE_ARG === null || SOURCE_ARG === source;

/** Champs lus par le client DexScreener (le reste : images, réseaux sociaux… n'est pas conservé). */
function trimDexPair(pair) {
  if (!pair || typeof pair !== 'object') return pair;
  const { chainId, dexId, pairAddress, labels, baseToken, quoteToken, priceNative, priceUsd, liquidity, pairCreatedAt } = pair;
  return { chainId, dexId, pairAddress, labels, baseToken, quoteToken, priceNative, priceUsd, liquidity, pairCreatedAt };
}

/** Attributs lus par le client GeckoTerminal. */
function trimGeckoPools(body) {
  if (!body || !Array.isArray(body.data)) return body;
  return {
    data: body.data.map((pool) => {
      const { address, name, pool_created_at, reserve_in_usd, base_token_price_usd } = pool.attributes ?? {};
      return {
        id: pool.id,
        type: pool.type,
        attributes: { address, name, pool_created_at, reserve_in_usd, base_token_price_usd },
        relationships: { base_token: pool.relationships?.base_token, quote_token: pool.relationships?.quote_token },
      };
    }),
  };
}

function save(source, scenario, request, status, body) {
  if (!wants(source)) return;
  const dir = join(OUT, source);
  mkdirSync(dir, { recursive: true });
  const fixture = { recordedAt: new Date().toISOString(), source, request, status, body };
  writeFileSync(join(dir, `${scenario}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`fixture ${source}/${scenario}.json (${status})`);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error' });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function rpc(method, params, useHelius = false) {
  const url = useHelius ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_KEY)}` : PUBLIC_RPC;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    redirect: 'error',
  });
  await sleep(useHelius ? 400 : 1_300);
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Réduit l'historique de signatures aux champs lus par le collecteur. */
function trimSignatures(body) {
  if (!body || !Array.isArray(body.result)) return body;
  return { ...body, result: body.result.map(({ signature, slot, blockTime, err }) => ({ signature, slot, blockTime, err })) };
}

/** Page pleine (token actif) : seules 100 entrées sont conservées, la requête est réécrite avec limit 100. */
const SIGNATURE_FIXTURE_LIMIT = 100;

async function recordRpc(name, mint) {
  const accountParams = [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }];
  const account = await rpc('getAccountInfo', accountParams);
  save('solana-rpc', `${name}.getAccountInfo`, { method: 'POST', rpcMethod: 'getAccountInfo', params: accountParams }, account.status, account.body);
  if (!account.body?.result?.value) return;

  const largestParams = [mint, { commitment: 'confirmed' }];
  const largest = await rpc('getTokenLargestAccounts', largestParams);
  save('solana-rpc', `${name}.getTokenLargestAccounts`, { method: 'POST', rpcMethod: 'getTokenLargestAccounts', params: largestParams }, largest.status, largest.body);

  const tokenAccounts = (largest.body?.result?.value ?? []).map((entry) => entry.address);
  if (tokenAccounts.length > 0) {
    const accountsParams = [tokenAccounts, { encoding: 'jsonParsed', commitment: 'confirmed' }];
    const accounts = await rpc('getMultipleAccounts', accountsParams);
    save('solana-rpc', `${name}.getMultipleAccounts.tokenAccounts`, { method: 'POST', rpcMethod: 'getMultipleAccounts', params: accountsParams }, accounts.status, accounts.body);

    const owners = [...new Set((accounts.body?.result?.value ?? []).map((a) => a?.data?.parsed?.info?.owner).filter(Boolean))];
    if (owners.length > 0) {
      const ownersParams = [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }];
      const ownerInfos = await rpc('getMultipleAccounts', ownersParams);
      save('solana-rpc', `${name}.getMultipleAccounts.owners`, { method: 'POST', rpcMethod: 'getMultipleAccounts', params: ownersParams }, ownerInfos.status, ownerInfos.body);
    }
  }

  const signaturesParams = [mint, { limit: 1000, commitment: 'confirmed' }];
  const raw = await rpc('getSignaturesForAddress', signaturesParams);
  const signatures = { status: raw.status, body: trimSignatures(raw.body) };
  const list = signatures.body?.result;
  if (Array.isArray(list) && list.length >= 1000) {
    signaturesParams[1].limit = SIGNATURE_FIXTURE_LIMIT;
    signatures.body.result = list.slice(0, SIGNATURE_FIXTURE_LIMIT);
  }
  save('solana-rpc', `${name}.getSignaturesForAddress`, { method: 'POST', rpcMethod: 'getSignaturesForAddress', params: signaturesParams }, signatures.status, signatures.body);
}

async function recordMarkets(name, mint) {
  const dexPath = `/token-pairs/v1/solana/${mint}`;
  const dex = await getJson(`https://api.dexscreener.com${dexPath}`);
  const dexBody = Array.isArray(dex.body) ? dex.body.map(trimDexPair) : dex.body;
  if (wants('dexscreener')) {
    save('dexscreener', name, { method: 'GET', path: dexPath, params: {} }, dex.status, dexBody);
    // Résolution paire → mint (lien DexScreener d'une paire) sur la paire principale.
    const main = Array.isArray(dex.body) ? dex.body[0] : undefined;
    if (main?.pairAddress && name === 'bonk') {
      await sleep(500);
      const pairPath = `/latest/dex/pairs/solana/${main.pairAddress}`;
      const pair = await getJson(`https://api.dexscreener.com${pairPath}`);
      const pairBody = pair.body && Array.isArray(pair.body.pairs) ? { ...pair.body, pairs: pair.body.pairs.map(trimDexPair) } : pair.body;
      if (pairBody && typeof pairBody === 'object') delete pairBody.pair;
      save('dexscreener', `${name}.pair`, { method: 'GET', path: pairPath, params: {} }, pair.status, pairBody);
    }
  }
  await sleep(500);
  if (SOURCE_ARG === 'dexscreener') return;

  const gtPath = `/networks/solana/tokens/${mint}/pools`;
  const gt = await getJson(`https://api.geckoterminal.com/api/v2${gtPath}`);
  save('geckoterminal', name, { method: 'GET', path: gtPath, params: {} }, gt.status, trimGeckoPools(gt.body));
  await sleep(6_500);

  const rcPath = `/tokens/${mint}/report`;
  const report = await getJson(`https://api.rugcheck.xyz/v1${rcPath}`);
  const reportSize = JSON.stringify(report.body ?? '').length;
  if (reportSize > 2_000_000) {
    // Rapport trop volumineux (tokens établis) : seul le marqueur est conservé, le client bascule sur le résumé.
    save('rugcheck', `${name}.report`, { method: 'GET', path: rcPath, params: {} }, report.status, { oversizeBytes: reportSize });
  } else {
    save('rugcheck', `${name}.report`, { method: 'GET', path: rcPath, params: {} }, report.status, report.body);
  }
  await sleep(1_200);
  const sumPath = `/tokens/${mint}/report/summary`;
  const summary = await getJson(`https://api.rugcheck.xyz/v1${sumPath}`);
  save('rugcheck', `${name}.summary`, { method: 'GET', path: sumPath, params: {} }, summary.status, summary.body);
  await sleep(1_200);

  // Devis de vente (aucune transaction) : ~100 USD au prix DexScreener, 1 unité sinon.
  const pair = Array.isArray(dex.body) ? dex.body.find((p) => p?.baseToken?.address === mint && p.priceUsd) : undefined;
  const decimals = await decimalsOf(mint);
  const price = pair ? Number(pair.priceUsd) : 0;
  const amount = price > 0 ? BigInt(Math.floor((100 / price) * 10 ** decimals)).toString() : (10n ** BigInt(decimals)).toString();
  const outputMint = mint === USDC ? WSOL : USDC;
  const params = { inputMint: mint, outputMint, amount, slippageBps: '500' };
  const query = new URLSearchParams(params).toString();
  const quote = await getJson(`https://lite-api.jup.ag/swap/v1/quote?${query}`);
  save('jupiter', name, { method: 'GET', path: '/quote', params }, quote.status, quote.body);
  await sleep(2_500);
}

const decimalsCache = new Map();
async function decimalsOf(mint) {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint);
  const account = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const decimals = account.body?.result?.value?.data?.parsed?.info?.decimals ?? 0;
  decimalsCache.set(mint, decimals);
  return decimals;
}

async function recordHelius(name, mint) {
  if (!/^[A-Za-z0-9-]{16,64}$/.test(HELIUS_KEY)) return;
  const params = { id: mint };
  const asset = await rpc('getAsset', params, true);
  save('helius', `${name}.getAsset`, { method: 'POST', rpcMethod: 'getAsset', params }, asset.status, asset.body);
}

async function main() {
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  for (const [name, mint] of Object.entries(TOKENS)) {
    if (only.length > 0 && !only.includes(name)) continue;
    if (wants('solana-rpc')) await recordRpc(name, mint);
    await recordMarkets(name, mint);
    if (wants('helius')) await recordHelius(name, mint);
  }
  if ((only.length === 0 || only.includes('missing')) && wants('solana-rpc')) {
    const params = [MISSING_MINT, { encoding: 'jsonParsed', commitment: 'confirmed' }];
    const missing = await rpc('getAccountInfo', params);
    save('solana-rpc', 'missing.getAccountInfo', { method: 'POST', rpcMethod: 'getAccountInfo', params }, missing.status, missing.body);
  }
}

main().catch((error) => {
  // Message générique : une erreur fetch peut contenir l'URL (et donc la clé Helius).
  console.error(`Échec de l'enregistrement : ${error?.name ?? 'Error'}`);
  process.exitCode = 1;
});
