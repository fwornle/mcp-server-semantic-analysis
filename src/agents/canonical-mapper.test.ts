/**
 * Unit tests for Phase 42.2 Plan 02 — canonical-mapper team option threading.
 *
 * Plan 02 Gap 1: canonical-mapper.ts CanonicalMapperOptions must accept
 * `team?: string` and stamp it into `metadata.team` on every produced Entity.
 * Source-of-truth: `.planning/forensics/report-42.2-00-canonical-emit.md` §1.3.
 *
 * Tests assert the four behavioural invariants locked in 42.2-02-PLAN.md
 * Task 1 <behavior> block:
 *   1. `{ team: 'coding' }` stamps `metadata.team === 'coding'` on the Entity.
 *   2. No options → `metadata.team === undefined` (not null, not empty string).
 *   3. `augmentWithCanonical` propagates team into the augmented entity's
 *      metadata (regression guard for the options-passthrough invariant).
 *   4. Edge: empty-string team (`{ team: '' }`) MUST NOT stamp metadata.team
 *      (validates the `length > 0` guard).
 *
 * Test framework: node:test + node:assert/strict (matches existing project
 * pattern; see src/storage/km-core-adapter.test.ts and
 * src/agents/coordinator-progress-merge.test.ts).
 *
 * Run via:
 *   npm run build && node --test dist/agents/canonical-mapper.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toCanonicalEntity, augmentWithCanonical } from './canonical-mapper.js';
import type { KGEntity } from './kg-operators.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRaw(overrides: Partial<KGEntity> = {}): KGEntity {
  return {
    id: 'mc4flkglue8o7',
    name: 'TestSubComponent',
    type: 'SubComponent',
    observations: [
      'TestSubComponent demonstrates the canonical emit path.',
      'It is exercised by Phase 42.2 Plan 02 unit tests.',
    ],
    significance: 5,
    level: 2,
    parentId: 'TestComponent',
    hierarchyPath: 'TestProject/TestComponent/TestSubComponent',
    ...overrides,
  };
}

const FIXED_RUN_ID = 'wave-analysis-test-fixture';
const FIXED_ONTOLOGY_CLASS = 'SubComponent';

// ===========================================================================
// Test 1 — { team: 'coding' } stamps metadata.team === 'coding'
// ===========================================================================

describe('Phase 42.2-02 Gap 1 — canonical-mapper team option', () => {
  it('Test 1: toCanonicalEntity with team:"coding" stamps metadata.team', () => {
    const raw = makeRaw();
    const entity = toCanonicalEntity(raw, FIXED_ONTOLOGY_CLASS, FIXED_RUN_ID, {
      team: 'coding',
    });

    assert.ok(entity.metadata, 'entity.metadata must be set');
    const metaTeam = (entity.metadata as Record<string, unknown>).team;
    assert.equal(metaTeam, 'coding', `expected metadata.team === 'coding', got ${String(metaTeam)}`);
  });

  // =========================================================================
  // Test 2 — no options → metadata.team is undefined (not null, not '')
  // =========================================================================

  it('Test 2: toCanonicalEntity without options leaves metadata.team undefined', () => {
    const raw = makeRaw();
    const entity = toCanonicalEntity(raw, FIXED_ONTOLOGY_CLASS, FIXED_RUN_ID);

    assert.ok(entity.metadata, 'entity.metadata must be set');
    const metaTeam = (entity.metadata as Record<string, unknown>).team;
    assert.equal(
      metaTeam,
      undefined,
      `expected metadata.team === undefined when no team option, got ${typeof metaTeam} ${String(metaTeam)}`,
    );
  });

  // =========================================================================
  // Test 3 — augmentWithCanonical propagates team (passthrough invariant)
  // =========================================================================

  it('Test 3: augmentWithCanonical propagates team into augmented metadata', () => {
    const raw = makeRaw();
    const augmented = augmentWithCanonical(raw, FIXED_ONTOLOGY_CLASS, FIXED_RUN_ID, {
      team: 'coding',
    });

    assert.ok(augmented.metadata, 'augmented.metadata must be set');
    const metaTeam = (augmented.metadata as Record<string, unknown>).team;
    assert.equal(
      metaTeam,
      'coding',
      `augmentWithCanonical must propagate team:'coding' to metadata.team, got ${String(metaTeam)}`,
    );
  });

  // =========================================================================
  // Test 4 — edge: empty-string team MUST NOT stamp metadata.team
  // =========================================================================

  it('Test 4: empty-string team does NOT stamp metadata.team (length > 0 guard)', () => {
    const raw = makeRaw();
    const entity = toCanonicalEntity(raw, FIXED_ONTOLOGY_CLASS, FIXED_RUN_ID, {
      team: '',
    });

    assert.ok(entity.metadata, 'entity.metadata must be set');
    const metaTeam = (entity.metadata as Record<string, unknown>).team;
    assert.equal(
      metaTeam,
      undefined,
      `empty-string team must NOT stamp metadata.team, got ${typeof metaTeam} ${String(metaTeam)}`,
    );
  });
});
