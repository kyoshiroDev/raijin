#!/usr/bin/env node
/**
 * Génère les fixtures **synthétiques** du scan de wallet (ARCHITECTURE.md §12.10) au format jsonParsed
 * réel (`solana-account-decoder` : `UiTokenAccount`, `delegate`, `delegatedAmount`, `state`), sans
 * réseau ni clé. Adresses déterministes (base58 de SHA-256 d'un libellé « raijin:fixture:… ») : elles
 * ne correspondent à aucun wallet réel connu. Reproductible :
 *   node libs/api/solana/scripts/build-wallet-fixtures.mjs
 * Les adresses imprimées doivent correspondre à `WALLET_FIXTURE_ADDRESSES` (src/lib/testing/wallet-fixtures.ts).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'fixtures');
const RECORDED_AT = '2026-11-22T12:00:00.000Z';
/** u64::MAX tel que l'émet le RPC (nombre JSON, arrondi à 18446744073709552000 en JavaScript). */
const RENT_EPOCH = 2 ** 64;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}
const addr = (label) => base58(createHash('sha256').update(`raijin:fixture:${label}`).digest());

const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const MINT_ACTIVE = 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi';
const RAYDIUM_AMM_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const BPF_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';

export const A = {
  delegation: addr('wallet:delegation'),
  danger: addr('wallet:danger'),
  empty: addr('wallet:empty'),
  tooLarge: addr('wallet:too-large'),
  safeMint: addr('mint:safe'),
  nftMint: addr('mint:nft'),
  safePair: addr('pair:safe'),
  delegate1: addr('delegate:1'),
  delegate2: addr('delegate:2'),
  delegate3: addr('delegate:3'),
  poolVaultOwner: addr('owner:pool-vault'),
};

const rpcBody = (result) => ({ jsonrpc: '2.0', id: 1, result });
const ctx = (value) => rpcBody({ context: { apiVersion: '3.0.6', slot: 472400000 }, value });
const fixture = (source, rpcMethod, params, body, note) => ({
  recordedAt: RECORDED_AT,
  source,
  synthetic: true,
  note,
  request: { method: 'POST', rpcMethod, params },
  status: 200,
  body,
});
const restFixture = (path, body, note) => ({
  recordedAt: RECORDED_AT,
  source: 'dexscreener',
  synthetic: true,
  note,
  request: { method: 'GET', path, params: {} },
  status: 200,
  body,
});
const write = (dir, name, value) => {
  mkdirSync(join(ROOT, dir), { recursive: true });
  writeFileSync(join(ROOT, dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
};
const readValue = (name) => JSON.parse(readFileSync(join(ROOT, 'solana-rpc', `${name}.getAccountInfo.json`), 'utf8')).body.result.value;

function uiAmount(raw, decimals) {
  const digits = BigInt(raw).toString();
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  const integer = padded.slice(0, -decimals);
  return fraction === '' ? integer : `${integer}.${fraction}`;
}
const tokenAmount = (raw, decimals) => ({
  amount: String(raw),
  decimals,
  uiAmount: Number(uiAmount(raw, decimals)),
  uiAmountString: uiAmount(raw, decimals),
});

/** Compte de token jsonParsed (SPL : 165 octets ; Token-2022 : 170 avec `immutableOwner`). */
function tokenAccount({ program, mint, owner, raw, decimals, delegate, delegatedRaw, frozen }) {
  const t22 = program === T22;
  const info = { isNative: false, mint, owner, state: frozen ? 'frozen' : 'initialized', tokenAmount: tokenAmount(raw, decimals) };
  if (delegate) {
    info.delegate = delegate;
    info.delegatedAmount = tokenAmount(delegatedRaw, decimals);
  }
  if (t22) info.extensions = [{ extension: 'immutableOwner' }];
  return {
    data: { parsed: { info, type: 'account' }, program: t22 ? 'spl-token-2022' : 'spl-token', space: t22 ? 170 : 165 },
    executable: false,
    lamports: t22 ? 2074080 : 2039280,
    owner: program,
    rentEpoch: RENT_EPOCH,
    space: t22 ? 170 : 165,
  };
}
const keyed = (pubkey, account) => ({ pubkey, account });
const systemAccount = (lamports) => ({ data: ['', 'base64'], executable: false, lamports, owner: SYSTEM, rentEpoch: RENT_EPOCH, space: 0 });
const accountInfoParams = (address) => [address, { encoding: 'jsonParsed', commitment: 'confirmed' }];
const byOwnerParams = (owner, programId) => [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }];

// --- Token « sain » synthétique (Raijin Fixture Safe) -------------------------------------------
const SAFE_SUPPLY = 1_000_000_000_000_000n; // 1 milliard de tokens à 6 décimales
const safeMintAccount = {
  data: {
    parsed: { info: { decimals: 6, freezeAuthority: null, isInitialized: true, mintAuthority: null, supply: SAFE_SUPPLY.toString() }, type: 'mint' },
    program: 'spl-token',
    space: 82,
  },
  executable: false,
  lamports: 1461600,
  owner: SPL,
  rentEpoch: RENT_EPOCH,
  space: 82,
};
const safePair = {
  chainId: 'solana',
  dexId: 'raydium',
  pairAddress: A.safePair,
  labels: ['CPMM'],
  baseToken: { address: A.safeMint, name: 'Raijin Fixture Safe', symbol: 'RFSAFE' },
  quoteToken: { address: WSOL, name: 'Wrapped SOL', symbol: 'SOL' },
  priceNative: '0.0018',
  priceUsd: '0.25',
  liquidity: { usd: 850000, base: 1700000, quote: 3000 },
  pairCreatedAt: 1709251200000,
};
const safeAsset = {
  interface: 'FungibleToken',
  id: A.safeMint,
  content: { metadata: { name: 'Raijin Fixture Safe', symbol: 'RFSAFE' } },
  authorities: [],
  creators: [],
  mutable: false,
  burnt: false,
};
const mintActiveAsset = {
  interface: 'FungibleToken',
  id: MINT_ACTIVE,
  content: { metadata: { name: 'Mint Active', symbol: 'MACT' } },
  authorities: [{ address: '644tv6RKk8MYQmYyTbm22YRTL25ZTMXJGVGA52GCsPp1', scopes: ['full'] }],
  mutable: true,
  burnt: false,
};

// Top 20 du token sain : coffre de pool Raydium (autorité connue, exclu), coffre CPMM (programme AMM, exclu), puis 18 wallets.
const pcts = [30, 12, ...Array.from({ length: 18 }, (_, index) => 2.9 - index * 0.15)];
const safeLargest = pcts.map((pct, index) => ({
  address: addr(`safe:holder-account:${index}`),
  owner: index === 0 ? RAYDIUM_AMM_AUTHORITY : index === 1 ? A.poolVaultOwner : addr(`safe:holder-wallet:${index}`),
  raw: ((SAFE_SUPPLY * BigInt(Math.round(pct * 10_000))) / 1_000_000n).toString(),
}));

const pairsOf = (name, count) => JSON.parse(readFileSync(join(ROOT, 'dexscreener', `${name}.json`), 'utf8')).body.slice(0, count);

function sortedJoin(mints) {
  return [...mints].sort().join(',');
}

// --- Écriture ---------------------------------------------------------------------------------------

// Nature des adresses.
write('solana-rpc', 'wallet-delegation.getAccountInfo', fixture('solana-rpc', 'getAccountInfo', accountInfoParams(A.delegation), ctx(systemAccount(1_250_000_000)), 'Wallet synthétique : compte système (SOL seulement).'));
write('solana-rpc', 'wallet-danger.getAccountInfo', fixture('solana-rpc', 'getAccountInfo', accountInfoParams(A.danger), ctx(systemAccount(80_000_000)), 'Wallet synthétique : compte système.'));
write('solana-rpc', 'wallet-empty.getAccountInfo', fixture('solana-rpc', 'getAccountInfo', accountInfoParams(A.empty), ctx(null), 'Wallet synthétique sans SOL : compte absent (scan normal, résultat vide).'));
write('solana-rpc', 'wallet-too-large.getAccountInfo', fixture('solana-rpc', 'getAccountInfo', accountInfoParams(A.tooLarge), ctx(systemAccount(5_000_000_000)), 'Wallet synthétique hors normes.'));
write(
  'solana-rpc',
  'wallet-program.getAccountInfo',
  fixture(
    'solana-rpc',
    'getAccountInfo',
    accountInfoParams(ORCA_WHIRLPOOL),
    ctx({ data: { parsed: { info: { programData: addr('program-data:whirlpool') }, type: 'program' }, program: 'bpf-upgradeable-loader', space: 36 }, executable: true, lamports: 1141440, owner: BPF_UPGRADEABLE, rentEpoch: RENT_EPOCH, space: 36 }),
    'Programme exécutable (Orca Whirlpool) saisi comme wallet : WALLET_INVALID.',
  ),
);

// Wallet avec délégations : SPL délégué en totalité, SPL vide délégué, Token-2022 délégué en partie, Token-2022 vide.
const delegationSpl = [
  keyed(addr('delegation:acct:safe'), tokenAccount({ program: SPL, mint: A.safeMint, owner: A.delegation, raw: 400_000_000n, decimals: 6, delegate: A.delegate1, delegatedRaw: 400_000_000n })),
  keyed(addr('delegation:acct:usdc-empty'), tokenAccount({ program: SPL, mint: USDC, owner: A.delegation, raw: 0n, decimals: 6, delegate: A.delegate2, delegatedRaw: 25_000_000n })),
];
const delegationT22 = [
  keyed(addr('delegation:acct:pyusd'), tokenAccount({ program: T22, mint: PYUSD, owner: A.delegation, raw: 40_000_000n, decimals: 6, delegate: A.delegate3, delegatedRaw: 10_000_000n })),
  keyed(addr('delegation:acct:mint-active-empty'), tokenAccount({ program: T22, mint: MINT_ACTIVE, owner: A.delegation, raw: 0n, decimals: 9 })),
];
write('solana-rpc', 'wallet-delegation.getTokenAccountsByOwner.spl', fixture('solana-rpc', 'getTokenAccountsByOwner', byOwnerParams(A.delegation, SPL), ctx(delegationSpl), 'Délégation totale (100 RFSAFE) et délégation sur un compte USDC vide.'));
write('solana-rpc', 'wallet-delegation.getTokenAccountsByOwner.token2022', fixture('solana-rpc', 'getTokenAccountsByOwner', byOwnerParams(A.delegation, T22), ctx(delegationT22), 'Délégation partielle PYUSD (10 sur 40) et compte Token-2022 vide.'));
write('dexscreener', 'wallet-delegation.tokens', restFixture(`/tokens/v1/solana/${sortedJoin([A.safeMint, PYUSD])}`, [safePair, ...pairsOf('pyusd', 5)], 'Prix du wallet avec délégations (lot trié).'));

// Wallet avec un token Danger (mint actif, sans prix), un sain, de la poussière USDC et un NFT.
const dangerSpl = [
  keyed(addr('danger:acct:safe'), tokenAccount({ program: SPL, mint: A.safeMint, owner: A.danger, raw: 2_000_000_000n, decimals: 6 })),
  keyed(addr('danger:acct:usdc-dust'), tokenAccount({ program: SPL, mint: USDC, owner: A.danger, raw: 400_000n, decimals: 6 })),
  keyed(addr('danger:acct:nft'), tokenAccount({ program: SPL, mint: A.nftMint, owner: A.danger, raw: 1n, decimals: 0 })),
];
const dangerT22 = [keyed(addr('danger:acct:mint-active'), tokenAccount({ program: T22, mint: MINT_ACTIVE, owner: A.danger, raw: 500_000_000_000n, decimals: 9 }))];
write('solana-rpc', 'wallet-danger.getTokenAccountsByOwner.spl', fixture('solana-rpc', 'getTokenAccountsByOwner', byOwnerParams(A.danger, SPL), ctx(dangerSpl), '500 RFSAFE, 0,4 USDC (poussière), 1 NFT.'));
write('solana-rpc', 'wallet-danger.getTokenAccountsByOwner.token2022', fixture('solana-rpc', 'getTokenAccountsByOwner', byOwnerParams(A.danger, T22), ctx(dangerT22), '500 tokens « mint actif » (autorité de mint active : Danger), sans prix.'));
write('dexscreener', 'wallet-danger.tokens', restFixture(`/tokens/v1/solana/${sortedJoin([A.safeMint, USDC, MINT_ACTIVE])}`, [safePair, ...pairsOf('usdc', 5)], 'Prix du wallet Danger : aucun pool pour le token « mint actif ».'));

// Wallet vide et wallet hors normes.
write('solana-rpc', 'wallet-empty.getTokenAccountsByOwner.spl', fixture('solana-rpc', 'getTokenAccountsByOwner', byOwnerParams(A.empty, SPL), ctx([]), 'Aucun compte SPL.'));
write('solana-rpc', 'wallet-empty.getTokenAccountsByOwner.token2022', fixture('solana-rpc', 'getTokenAccountsByOwner', byOwnerParams(A.empty, T22), ctx([]), 'Aucun compte Token-2022.'));
const largeMint = addr('mint:airdrop');
// Liste développée au rejeu par `createFixtureFetch` (1 001 comptes jsonParsed déterministes) : évite un fichier de 1 Mo.
const large = { $synthetic: 'tokenAccounts', count: 1001, owner: A.tooLarge, programId: SPL, mint: largeMint, decimals: 6, seed: 'too-large' };
write('solana-rpc', 'wallet-too-large.getTokenAccountsByOwner.spl', fixture('solana-rpc', 'getTokenAccountsByOwner', byOwnerParams(A.tooLarge, SPL), ctx(large), '1 001 comptes SPL : au-delà du plafond de 1 000 (WALLET_TOO_LARGE).'));
write('solana-rpc', 'wallet-too-large.getTokenAccountsByOwner.token2022', fixture('solana-rpc', 'getTokenAccountsByOwner', byOwnerParams(A.tooLarge, T22), ctx([]), 'Aucun compte Token-2022.'));

// Comptes de mint et DAS par lot : chaque sous-ensemble (lots triés), pour rejouer aussi avec un cache partiel.
const mintValues = { [A.safeMint]: safeMintAccount, [PYUSD]: readValue('pyusd'), [MINT_ACTIVE]: readValue('mint-active') };
const assets = { [A.safeMint]: safeAsset, [MINT_ACTIVE]: mintActiveAsset };
const subsets = [
  ['safe', [A.safeMint]],
  ['pyusd', [PYUSD]],
  ['mint-active', [MINT_ACTIVE]],
  ['pyusd-safe', [A.safeMint, PYUSD]],
  ['mint-active-safe', [A.safeMint, MINT_ACTIVE]],
];
for (const [name, mints] of subsets) {
  const sorted = [...mints].sort();
  write('solana-rpc', `wallet-mints.${name}.getMultipleAccounts`, fixture('solana-rpc', 'getMultipleAccounts', [sorted, { encoding: 'jsonParsed', commitment: 'confirmed' }], ctx(sorted.map((mint) => mintValues[mint])), 'Comptes de mint du scan (lot trié).'));
  const pairs = sorted.flatMap((mint) => (mint === A.safeMint ? [safePair] : mint === PYUSD ? pairsOf('pyusd', 5) : []));
  // Lot [PYUSD, RFSAFE] : même requête que les prix du wallet avec délégations (fixture déjà écrite).
  if (name !== 'pyusd-safe') write('dexscreener', `wallet-mints.${name}.tokens`, restFixture(`/tokens/v1/solana/${sorted.join(',')}`, pairs, 'Paires du lot de verdicts (prix absents du cache).'));
  write('helius', `wallet-mints.${name}.getAssetBatch`, fixture('helius', 'getAssetBatch', { ids: sorted }, rpcBody(sorted.flatMap((mint) => (assets[mint] ? [assets[mint]] : []))), 'DAS par lot (PYUSD absent : métadonnées via l’extension Token-2022).'));
}

// Holders du token sain (avec clé) : top 20, propriétaires (lot trié), programmes des propriétaires (lot trié).
write('helius', 'wallet-safe.getTokenLargestAccounts', fixture('helius', 'getTokenLargestAccounts', [A.safeMint, { commitment: 'confirmed' }], ctx(safeLargest.map((entry) => ({ address: entry.address, amount: entry.raw, decimals: 6, uiAmount: Number(uiAmount(entry.raw, 6)), uiAmountString: uiAmount(entry.raw, 6) }))), 'Top 20 : coffre Raydium (exclu), coffre CPMM (exclu), 18 wallets (top 10 ≈ 22 %).'));
const ownerAccounts = [...safeLargest].sort((a, b) => (a.address < b.address ? -1 : 1));
write('helius', 'wallet-safe.getMultipleAccounts.tokenAccounts', fixture('helius', 'getMultipleAccounts', [ownerAccounts.map((entry) => entry.address), { encoding: 'jsonParsed', commitment: 'confirmed' }], ctx(ownerAccounts.map((entry) => tokenAccount({ program: SPL, mint: A.safeMint, owner: entry.owner, raw: BigInt(entry.raw), decimals: 6 }))), 'Propriétaires des 20 plus gros comptes (lot trié).'));
const owners = [...new Set(safeLargest.map((entry) => entry.owner))].sort();
write('helius', 'wallet-safe.getMultipleAccounts.programs', fixture('helius', 'getMultipleAccounts', [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }], ctx(owners.map((owner) => (owner === A.poolVaultOwner ? { data: ['', 'base64'], executable: false, lamports: 2039280, owner: RAYDIUM_CPMM, rentEpoch: RENT_EPOCH, space: 0 } : systemAccount(10_000_000)))), 'Programmes des propriétaires : un coffre Raydium CPMM (exclu), des wallets système.'));

console.log(JSON.stringify({ ...A, largeMint }, null, 2));
