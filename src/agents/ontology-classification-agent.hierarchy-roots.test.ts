/**
 * Phase 60 Plan 04 Task 3 — Writer-side hard-root guard tests (D-14).
 *
 * Locks the contract that `classifySingleObservation()` short-circuits LLM
 * classification for observations whose `name` is one of the 5 hierarchy
 * roots imported from `@fwornle/km-core` HIERARCHY_ROOTS:
 *
 *   - CollectiveKnowledge -> ontologyClass='System'   (the VKB system root)
 *   - Coding              -> ontologyClass='Project'
 *   - DynArch             -> ontologyClass='Project'
 *   - Timeline            -> ontologyClass='Project'
 *   - Normalisa           -> ontologyClass='Project'
 *
 * For these names the underlying `classifier.classify` is NEVER invoked
 * (no LLM cost; no LLM verdict can drift the class), and the returned
 * `OntologyMetadata.classificationMethod` is the new literal
 * `'hard-root-guard'`. For every other name the classifier flows through
 * unchanged.
 *
 * Test framework: node:test + node:assert/strict (matches the project's
 * existing test convention — see `ontology-classification-agent.test.ts`).
 *
 * Run via:
 *   npm run build && node --test dist/agents/ontology-classification-agent.hierarchy-roots.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { OntologyClassificationAgent } from './ontology-classification-agent.js';
import {
  HIERARCHY_ROOTS,
  HIERARCHY_ROOT_CLASS,
} from '@fwornle/km-core';

// ---------------------------------------------------------------------------
// Tmpdir-isolated ontology fixture — copies the live `.data/ontologies/`
// upper + coding-ontology files so OntologyConfigManager.initialize()
// resolves a usable registry. Mirrors the pattern in
// `ontology-classification-agent.test.ts` which sets up the L2-refinement
// registry the same way.
// ---------------------------------------------------------------------------

const REPO_ROOT = (() => {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (dir !== '/' && !fs.existsSync(path.join(dir, '.data/ontologies/upper.json'))) {
    dir = path.dirname(dir);
  }
  return dir;
})();

const SOURCE_ONTO_DIR = path.join(REPO_ROOT, '.data/ontologies');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-classification-agent-hroot-test-'));
  // Mirror the layout the agent constructor expects:
  // `<basePath>/.data/ontologies/{upper,coding-ontology,coding.lower}.json`.
  const tmpOntoDir = path.join(tmpDir, '.data/ontologies');
  fs.mkdirSync(tmpOntoDir, { recursive: true });
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

// ---------------------------------------------------------------------------
// Mock classifier — captures call counts so we can assert the guard
// short-circuits BEFORE invoking the LLM path. The agent's private
// `classifier` field gets reassigned to this stub after `initialize()`.
// ---------------------------------------------------------------------------

interface MockClassifierState {
  callCount: number;
  lastInput: string | null;
}

function makeMockClassifier(state: MockClassifierState) {
  return {
    classify: async (input: string, _opts: { team: string; minConfidence: number }) => {
      state.callCount += 1;
      state.lastInput = input;
      return {
        entityClass: 'MockClass',
        confidence: 0.99,
        method: 'llm' as const,
        ontology: 'coding',
        properties: {},
      };
    },
  };
}

async function buildAgentWithMock(state: MockClassifierState) {
  const agent = new OntologyClassificationAgent('coding', tmpDir);
  await agent.initialize();
  // Replace the underlying classifier with the mock. The agent stores it
  // on the private `classifier` field — we reach in via index-access.
  (agent as unknown as { classifier: unknown }).classifier = makeMockClassifier(state);
  return agent;
}

// ---------------------------------------------------------------------------
// Helper: invoke the private `classifySingleObservation` via index-access.
// The plan exempts these five names BEFORE the existing
// `buildClassificationInput` call, so we exercise the same method the
// production code paths call.
// ---------------------------------------------------------------------------

async function classifyOne(agent: OntologyClassificationAgent, observation: unknown) {
  // The private method signature is `(observation: any, minConfidence: number)`.
  // We pass a typical minConfidence value used elsewhere in this agent.
  return (agent as unknown as {
    classifySingleObservation: (obs: unknown, minConfidence: number) => Promise<{
      ontologyMetadata: {
        ontologyClass: string;
        classificationMethod: string;
        classificationConfidence: number;
        ontologySource: 'upper' | 'lower';
      };
      classified: boolean;
      original: unknown;
    }>;
  }).classifySingleObservation(observation, 0.6);
}

// ===========================================================================
// Test cases — mirror the <behavior> block in Phase 60 Plan 04 Task 3.
// ===========================================================================

describe('Phase 60 D-14 — OntologyClassificationAgent hard-root guard', () => {
  it('Test 1: CollectiveKnowledge short-circuits to ontologyClass=System; classifier NOT called', async () => {
    const state: MockClassifierState = { callCount: 0, lastInput: null };
    const agent = await buildAgentWithMock(state);

    const result = await classifyOne(agent, { name: 'CollectiveKnowledge', entityType: 'System' });

    assert.equal(result.ontologyMetadata.ontologyClass, 'System');
    assert.equal(result.ontologyMetadata.classificationMethod, 'hard-root-guard');
    assert.equal(result.classified, true, 'hard-root classification is always considered successful');
    assert.equal(state.callCount, 0, 'classifier.classify MUST NOT be invoked for hierarchy roots');
  });

  it('Test 2: Coding short-circuits to ontologyClass=Project; classifier NOT called', async () => {
    const state: MockClassifierState = { callCount: 0, lastInput: null };
    const agent = await buildAgentWithMock(state);

    const result = await classifyOne(agent, { name: 'Coding', entityType: 'Project' });

    assert.equal(result.ontologyMetadata.ontologyClass, 'Project');
    assert.equal(result.ontologyMetadata.classificationMethod, 'hard-root-guard');
    assert.equal(state.callCount, 0);
  });

  it('Test 3a: DynArch short-circuits to ontologyClass=Project', async () => {
    const state: MockClassifierState = { callCount: 0, lastInput: null };
    const agent = await buildAgentWithMock(state);
    const result = await classifyOne(agent, { name: 'DynArch' });
    assert.equal(result.ontologyMetadata.ontologyClass, 'Project');
    assert.equal(result.ontologyMetadata.classificationMethod, 'hard-root-guard');
    assert.equal(state.callCount, 0);
  });

  it('Test 3b: Timeline short-circuits to ontologyClass=Project', async () => {
    const state: MockClassifierState = { callCount: 0, lastInput: null };
    const agent = await buildAgentWithMock(state);
    const result = await classifyOne(agent, { name: 'Timeline' });
    assert.equal(result.ontologyMetadata.ontologyClass, 'Project');
    assert.equal(result.ontologyMetadata.classificationMethod, 'hard-root-guard');
    assert.equal(state.callCount, 0);
  });

  it('Test 3c: Normalisa short-circuits to ontologyClass=Project', async () => {
    const state: MockClassifierState = { callCount: 0, lastInput: null };
    const agent = await buildAgentWithMock(state);
    const result = await classifyOne(agent, { name: 'Normalisa' });
    assert.equal(result.ontologyMetadata.ontologyClass, 'Project');
    assert.equal(result.ontologyMetadata.classificationMethod, 'hard-root-guard');
    assert.equal(state.callCount, 0);
  });

  it('Test 4: non-root name (SomeComponent) flows through to the classifier (called exactly once)', async () => {
    const state: MockClassifierState = { callCount: 0, lastInput: null };
    const agent = await buildAgentWithMock(state);

    const result = await classifyOne(agent, {
      name: 'SomeComponent',
      entityType: 'Component',
      description: 'A non-root entity that should hit the LLM path',
    });

    // The mock returns entityClass='MockClass' — the guard MUST NOT short-circuit.
    assert.equal(state.callCount, 1, 'classifier.classify MUST be invoked for non-root names');
    assert.equal(result.ontologyMetadata.ontologyClass, 'MockClass');
    assert.notEqual(result.ontologyMetadata.classificationMethod, 'hard-root-guard');
  });

  it('Test 5: defensive — observation.name=null/undefined falls through to classifier without crash', async () => {
    const stateNull: MockClassifierState = { callCount: 0, lastInput: null };
    const agentNull = await buildAgentWithMock(stateNull);

    const resultNull = await classifyOne(agentNull, { name: null, entityType: 'Component' });
    assert.equal(stateNull.callCount, 1, 'null name MUST fall through to the classifier');
    assert.equal(resultNull.ontologyMetadata.ontologyClass, 'MockClass');

    const stateUndef: MockClassifierState = { callCount: 0, lastInput: null };
    const agentUndef = await buildAgentWithMock(stateUndef);
    const resultUndef = await classifyOne(agentUndef, { entityType: 'Component' });
    assert.equal(stateUndef.callCount, 1, 'undefined name MUST fall through to the classifier');
    assert.equal(resultUndef.ontologyMetadata.ontologyClass, 'MockClass');
  });

  it('Test 6: HIERARCHY_ROOTS surface witness — all 5 names short-circuit; classifier call count stays at 0', async () => {
    const state: MockClassifierState = { callCount: 0, lastInput: null };
    const agent = await buildAgentWithMock(state);

    for (const rootName of HIERARCHY_ROOTS) {
      const result = await classifyOne(agent, { name: rootName, entityType: 'Component' });
      const expectedClass = HIERARCHY_ROOT_CLASS[rootName];
      assert.equal(
        result.ontologyMetadata.ontologyClass,
        expectedClass,
        `${rootName} must classify to ${expectedClass}`,
      );
      assert.equal(result.ontologyMetadata.classificationMethod, 'hard-root-guard');
    }
    assert.equal(state.callCount, 0, 'classifier.classify MUST stay at 0 across all 5 roots');
  });
});
