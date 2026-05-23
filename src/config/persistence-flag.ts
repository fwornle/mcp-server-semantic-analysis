/**
 * Persistence backend feature flag — Phase 42 D-51a.
 *
 * During the strangler migration from B's legacy GraphDatabaseService to
 * km-core's GraphKMStore, this flag decides which backend handles writes.
 *
 *   KM_CORE_PERSISTENCE=km-core  →  use the new km-core adapter (Plan 01)
 *   KM_CORE_PERSISTENCE=<other>  →  use the legacy GraphDatabaseService
 *   KM_CORE_PERSISTENCE=<unset>  →  use the legacy GraphDatabaseService (default)
 *
 * The flag is intentionally strict: only the literal string `km-core` flips
 * the switch. Any other value (typo, empty string, wrong casing) falls back
 * to legacy. This guards against accidental opt-in during dev/test rotation.
 *
 * The flag is deleted in Phase 42's final cleanup plan (D-51) once all of
 * B's write paths have migrated and the legacy modules are removed.
 */

export type PersistenceBackend = 'legacy' | 'km-core';

/** Read the persistence-backend feature flag from the environment. */
export function getPersistenceBackend(): PersistenceBackend {
  return process.env.KM_CORE_PERSISTENCE === 'km-core' ? 'km-core' : 'legacy';
}
