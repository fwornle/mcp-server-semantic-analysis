/**
 * Unit tests for Phase 57 Plan 04 — OntologyClassificationAgent L2 refinement.
 *
 * Plan 04 D-10: the classifier loads 10 L2 classes from `.data/ontologies/
 * coding.lower.json` via OntologyRegistry at startup, exposes them through a
 * prompt-rendering helper, and falls back gracefully when the lower-onto file
 * is absent. The four behaviour cases below mirror the plan's <behavior> block.
 *
 * Tested surface (additive only — does not touch the existing
 * classifySingleObservation() / classify() pipeline):
 *   - `loadL2Classes(registry)` — pure function: filters a registry to classes
 *     whose `extends` is one of Component/SubComponent/Detail.
 *   - `buildL2RefinementPrompt(l1Class, l2Classes)` — pure function: renders
 *     the refinement instruction + L2 vocabulary as a single string. Returns
 *     empty string when the L1 class is not in the refinable set OR when the
 *     L2 class list is empty (graceful no-op).
 *   - `extractL2FromLLMResponse(rawText, validL2Names, l1Fallback)` — pure
 *     function: parses the LLM's refinement response; rejects hallucinated
 *     class names (not in registered set) and falls back to L1 parent.
 *
 * Test framework: node:test + node:assert/strict (matches existing project
 * pattern — see src/agents/canonical-mapper.test.ts and
 * src/agents/coordinator-progress-merge.test.ts).
 *
 * Run via:
 *   npm run build && node --test dist/agents/ontology-classification-agent.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  loadL2Classes,
  buildL2RefinementPrompt,
  extractL2FromLLMResponse,
  REFINABLE_L1_PARENTS,
} from './ontology-classification-agent.js';

import { OntologyRegistry } from '@fwornle/km-core';

// ---------------------------------------------------------------------------
// Tmpdir-isolated registry fixture — copies upper.json + coding-ontology.json
// + coding.lower.json from the live .data/ontologies/ tree so the registry
// chain (upper → coding-ontology → coding.lower) resolves identically to
// the production load path. We avoid copying the other production ontology
// files (raas, agentic, etc.) to keep the test deterministic.
// ---------------------------------------------------------------------------

const REPO_ROOT = (() => {
  // Walk up from this file's directory looking for `.data/ontologies/upper.json`.
  // src/agents/<file>.test.ts → dist/agents/<file>.test.js → walk up to repo root.
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (dir !== '/' && !fs.existsSync(path.join(dir, '.data/ontologies/upper.json'))) {
    dir = path.dirname(dir);
  }
  return dir;
})();

const SOURCE_ONTO_DIR = path.join(REPO_ROOT, '.data/ontologies');

let tmpDir: string;
let tmpOntoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-classification-agent-test-'));
  tmpOntoDir = path.join(tmpDir, 'ontologies');
  fs.mkdirSync(tmpOntoDir, { recursive: true });
  // Copy upper.json + coding-ontology.json (required for chain) + coding.lower.json
  for (const file of ['upper.json', 'coding-ontology.json', 'coding.lower.json']) {
    const src = path.join(SOURCE_ONTO_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(tmpOntoDir, file));
    }
  }
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ===========================================================================
// Test 1 — loadL2Classes returns the 10 classes from coding.lower.json
// ===========================================================================

describe('Phase 57-04 — OntologyClassificationAgent L2 refinement', () => {
  it('Test 1: loadL2Classes returns 10 classes from coding.lower.json with correct L1 parents', () => {
    const registry = new OntologyRegistry({ ontologyDir: tmpOntoDir });
    const l2Classes = loadL2Classes(registry);

    assert.equal(l2Classes.length, 10, `expected 10 L2 classes, got ${l2Classes.length}`);

    const names = l2Classes.map((c) => c.name).sort();
    const expectedNames = [
      'BatchSemanticAnalysis',
      'ConstraintMonitor',
      'DockerizedServices',
      'EtmDaemon',
      'KnowledgeManagement',
      'LiveLoggingSystem',
      'OnlineDigest',
      'OnlineInsight',
      'OnlineObservation',
      'RapidLlmProxy',
    ].sort();

    assert.deepEqual(names, expectedNames, 'expected exact L2 class name set');

    // Every L2 class must extend one of the refinable L1 parents.
    for (const cls of l2Classes) {
      assert.ok(
        cls.extends && REFINABLE_L1_PARENTS.includes(cls.extends),
        `L2 class ${cls.name} must extend Component/SubComponent/Detail (got ${cls.extends})`,
      );
    }
  });

  // =========================================================================
  // Test 2 — buildL2RefinementPrompt renders refinement step for refinable L1
  // =========================================================================

  it('Test 2: buildL2RefinementPrompt renders 10 class names + descriptions when L1 is Component', () => {
    const registry = new OntologyRegistry({ ontologyDir: tmpOntoDir });
    const l2Classes = loadL2Classes(registry);

    const prompt = buildL2RefinementPrompt('Component', l2Classes);

    assert.ok(prompt.length > 0, 'expected non-empty prompt for refinable L1 class');
    assert.match(prompt, /REFINEMENT STEP/, 'prompt must contain REFINEMENT STEP marker');
    assert.match(prompt, /LiveLoggingSystem/, 'prompt must contain LiveLoggingSystem name');
    assert.match(prompt, /ETM/, 'prompt must contain LiveLoggingSystem description (mentions ETM)');
    assert.match(prompt, /EtmDaemon/, 'prompt must contain EtmDaemon name');

    // All 10 L2 names must appear.
    for (const cls of l2Classes) {
      assert.ok(prompt.includes(cls.name), `prompt must contain L2 name ${cls.name}`);
    }
  });

  // =========================================================================
  // Test 3 — buildL2RefinementPrompt returns empty for non-refinable L1
  // =========================================================================

  it('Test 3: buildL2RefinementPrompt returns empty string for non-refinable L1 (e.g. Project, File)', () => {
    const registry = new OntologyRegistry({ ontologyDir: tmpOntoDir });
    const l2Classes = loadL2Classes(registry);

    // Project / File / Service are NOT in REFINABLE_L1_PARENTS — no refinement.
    assert.equal(buildL2RefinementPrompt('Project', l2Classes), '');
    assert.equal(buildL2RefinementPrompt('File', l2Classes), '');
    assert.equal(buildL2RefinementPrompt('Service', l2Classes), '');
    assert.equal(buildL2RefinementPrompt('Unclassified', l2Classes), '');
  });

  // =========================================================================
  // Test 4 — graceful degrade when coding.lower.json is absent
  // =========================================================================

  it('Test 4: loadL2Classes returns [] when coding.lower.json is missing; buildL2RefinementPrompt no-ops', () => {
    // Remove coding.lower.json from the tmpdir to simulate file-missing case.
    fs.rmSync(path.join(tmpOntoDir, 'coding.lower.json'));

    const registry = new OntologyRegistry({ ontologyDir: tmpOntoDir });
    const l2Classes = loadL2Classes(registry);

    assert.equal(l2Classes.length, 0, 'expected 0 L2 classes when coding.lower.json absent');
    // Even with a refinable L1 class, empty L2 list → empty prompt (graceful no-op).
    assert.equal(buildL2RefinementPrompt('Component', l2Classes), '');
    assert.equal(buildL2RefinementPrompt('Detail', l2Classes), '');
    assert.equal(buildL2RefinementPrompt('SubComponent', l2Classes), '');
  });

  // =========================================================================
  // Test 5 — extractL2FromLLMResponse honors registered set + L1 fallback
  // =========================================================================

  it('Test 5: extractL2FromLLMResponse returns L2 when in registered set, L1 fallback otherwise', () => {
    const validNames = [
      'LiveLoggingSystem',
      'ConstraintMonitor',
      'OnlineObservation',
      'OnlineDigest',
      'OnlineInsight',
      'KnowledgeManagement',
      'BatchSemanticAnalysis',
      'RapidLlmProxy',
      'DockerizedServices',
      'EtmDaemon',
    ];

    // Case A: LLM returns a valid L2 class name verbatim → return it.
    assert.equal(
      extractL2FromLLMResponse('LiveLoggingSystem', validNames, 'Component'),
      'LiveLoggingSystem',
    );

    // Case B: LLM returns valid L2 embedded in a sentence → extract it.
    assert.equal(
      extractL2FromLLMResponse(
        'After consideration the class is EtmDaemon.',
        validNames,
        'SubComponent',
      ),
      'EtmDaemon',
    );

    // Case C: LLM hallucinates an unregistered class → reject and fall back to L1.
    assert.equal(
      extractL2FromLLMResponse('SuperLoggerSystemX', validNames, 'Component'),
      'Component',
      'hallucinated class must be rejected — fall back to L1 parent',
    );

    // Case D: LLM declines / returns L1 verbatim → fall back to L1.
    assert.equal(
      extractL2FromLLMResponse('Component', validNames, 'Component'),
      'Component',
    );

    // Case E: empty/null response → fall back to L1.
    assert.equal(extractL2FromLLMResponse('', validNames, 'Detail'), 'Detail');
    assert.equal(extractL2FromLLMResponse('   ', validNames, 'Detail'), 'Detail');
  });
});
