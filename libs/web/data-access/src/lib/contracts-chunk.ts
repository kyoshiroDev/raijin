/**
 * Point d'entrée du chunk « contrats » (schémas Zod), chargé par `loadContracts()`.
 * Import dynamique d'un module local : les autres fichiers de la lib peuvent toujours importer
 * `@raijin/shared-contracts` statiquement (écrans chargés à la demande).
 */
export * from '@raijin/shared-contracts';
