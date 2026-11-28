/**
 * Adresses des fixtures **synthétiques** du scan de wallet (ARCHITECTURE.md §12.10), générées par
 * `libs/api/solana/scripts/build-wallet-fixtures.mjs` (adresses déterministes, aucun wallet réel).
 * Rejeu : `createFixtureFetch(loadAllFixtures())` les inclut (avec ou sans clé Helius factice).
 *
 * | Scénario | Attendu |
 * |---|---|
 * | `delegation` | 2 tokens (RFSAFE sain, PYUSD), 3 délégations : RFSAFE totale (SPL), USDC sur compte vide (SPL), PYUSD partielle (Token-2022) ; 1 compte vide |
 * | `danger` | RFSAFE (Sain, 6/9 avec clé, 4/9 sans), « mint actif » (Danger, sans prix), USDC 0,4 (poussière), 1 NFT |
 * | `empty` | compte absent, aucun compte de token : résultat vide |
 * | `tooLarge` | 1 001 comptes SPL : `WalletTooLargeError` (`WALLET_TOO_LARGE`) |
 * | `isToken` | mint (« mint actif ») : `WalletIsTokenError` (`WALLET_IS_TOKEN`) |
 * | `program` | programme exécutable (Orca Whirlpool) : `WalletInvalidError` (`WALLET_INVALID`) |
 */
export const WALLET_FIXTURE_ADDRESSES = {
  delegation: 'HeESQ5wM9nFoXTgiNY2XWpK5PtiUfQ7kTvk3kk6ksZwf',
  danger: '2Vm2knf2ywSNrKhQSgKTE3sUawpzs9GY32HYeDvA6W6N',
  empty: '54SpU9vgpM99H5qc91upiTYXe3i7gQ2RM78BHZoTDayp',
  tooLarge: '53Bmgioqf3gPGEKErmJtVaJrV8SoDf52nPVzeNALMaVW',
  isToken: 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi',
  program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
} as const;

/** Autres adresses utiles aux assertions (mints, délégués). */
export const WALLET_FIXTURE_ACCOUNTS = {
  safeMint: '9N3J88UmdXNRJVUCgTjuR52tWLNmzkzxg1atuBYnuRew',
  mintActive: 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  pyusd: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  nftMint: '2F2uCcFNwSLPxqP3h9nyE9pJzUELnGpdckCZXqV8yac2',
  delegateFull: 'FbpneW1TW5P8ZULWwPxaRqxKgWiMJ48sT6buhkqgfTAT',
  delegateEmptyAccount: '7Td8GgrVo4L2VuRASS9NVNTQaAzsh2NY5jzvjiqaExgq',
  delegatePartial: 'Uwbx7KF9hCB7YCYJxqZhVXD8Dhgezn7AWVWdiDDNAw8',
} as const;
