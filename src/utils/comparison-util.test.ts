/**
 * Tests for migration schema parsing and snapshot comparison utility.
 *
 * Covers:
 * - WorkflowStateWithMigrationSchema old-format -> new-format parsing
 * - WorkflowStateWithMigrationSchema new-format pass-through
 * - compareSnapshots: matching files, differing files, missing files
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { WorkflowStateWithMigrationSchema } from '../shared/workflow-types/schemas.js';
import { compareSnapshots, type Divergence } from './comparison-util.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Old flat-format progress data (what coordinator's writeProgressFile historically produced) */
const oldFormatFixture = {
  status: 'starting',
  currentStep: 'semantic_analysis',
  stepsCompleted: 2,
  totalSteps: 8,
  workflowName: 'wave-analysis',
  startTime: '2026-03-10T10:00:00Z',
  lastUpdate: '2026-03-10T10:05:00Z',
  elapsedSeconds: 300,
  singleStepMode: false,
  mockLLM: true,
  llmMode: 'mock',
  stepIntoSubsteps: false,
  workflowId: 'test-wf-001',
};

/** New structured-format progress data (what state machine subscriber produces) */
const newFormatFixture = {
  status: 'running' as const,
  subStatus: 'executing-step' as const,
  workflowId: 'test-wf-002',
  workflowName: 'wave-analysis',
  config: {
    singleStepMode: false,
    mockLLM: false,
    llmMode: 'public' as const,
    stepIntoSubsteps: false,
  },
  progress: {
    currentStepIndex: 1,
    currentStepName: 'classify_entities',
    completedSteps: ['semantic_analysis'],
    startTime: '2026-03-10T10:00:00Z',
    lastUpdate: '2026-03-10T10:02:00Z',
    elapsedSeconds: 120,
  },
};

// ---------------------------------------------------------------------------
// Migration schema tests (MIG-02 coverage)
// ---------------------------------------------------------------------------

describe('WorkflowStateWithMigrationSchema', () => {
  it('parses old-format fixture into valid new-format state', () => {
    const result = WorkflowStateWithMigrationSchema.parse(oldFormatFixture);
    // Old 'starting' maps to 'running'
    assert.equal(result.status, 'running');
    if (result.status === 'running') {
      assert.equal(result.subStatus, 'executing-step');
      assert.equal(result.workflowName, 'wave-analysis');
      assert.equal(result.config.mockLLM, true);
      assert.equal(result.progress.currentStepIndex, 2);
      assert.equal(result.progress.currentStepName, 'semantic_analysis');
    }
  });

  it('parses new-format fixture through unchanged', () => {
    const result = WorkflowStateWithMigrationSchema.parse(newFormatFixture);
    assert.equal(result.status, 'running');
    if (result.status === 'running') {
      assert.equal(result.workflowId, 'test-wf-002');
      assert.equal(result.progress.currentStepName, 'classify_entities');
      assert.equal(result.config.singleStepMode, false);
    }
  });
});

// ---------------------------------------------------------------------------
// compareSnapshots tests
// ---------------------------------------------------------------------------

describe('compareSnapshots', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when both files have equivalent data', () => {
    const legacyPath = path.join(tmpDir, 'legacy.json');
    const newPath = path.join(tmpDir, 'new.json');

    // Legacy (old flat format)
    fs.writeFileSync(legacyPath, JSON.stringify({
      status: 'running',
      currentStep: 'semantic_analysis',
      stepsCompleted: 2,
      totalSteps: 8,
      workflowName: 'wave-analysis',
    }));

    // New (structured format with equivalent values)
    fs.writeFileSync(newPath, JSON.stringify({
      status: 'running',
      subStatus: 'executing-step',
      workflowId: 'wf-001',
      workflowName: 'wave-analysis',
      config: { singleStepMode: false, mockLLM: false, llmMode: 'public', stepIntoSubsteps: false },
      progress: {
        currentStepIndex: 2,
        currentStepName: 'semantic_analysis',
        completedSteps: ['step1', 'step2'],
        startTime: '2026-03-10T10:00:00Z',
        lastUpdate: '2026-03-10T10:05:00Z',
        elapsedSeconds: 300,
      },
    }));

    const divergences = compareSnapshots(legacyPath, newPath);
    assert.deepEqual(divergences, []);
  });

  it('returns Divergence[] when legacy and new files differ on a mapped field', () => {
    const legacyPath = path.join(tmpDir, 'legacy.json');
    const newPath = path.join(tmpDir, 'new.json');

    // Legacy says currentStep = 'semantic_analysis'
    fs.writeFileSync(legacyPath, JSON.stringify({
      status: 'running',
      currentStep: 'semantic_analysis',
      stepsCompleted: 2,
      totalSteps: 8,
      workflowName: 'wave-analysis',
    }));

    // New says currentStepName = 'classify_entities' (DIFFERENT)
    fs.writeFileSync(newPath, JSON.stringify({
      status: 'running',
      subStatus: 'executing-step',
      workflowId: 'wf-001',
      workflowName: 'wave-analysis',
      config: { singleStepMode: false, mockLLM: false, llmMode: 'public', stepIntoSubsteps: false },
      progress: {
        currentStepIndex: 3,
        currentStepName: 'classify_entities',
        completedSteps: ['step1', 'step2', 'step3'],
        startTime: '2026-03-10T10:00:00Z',
        lastUpdate: '2026-03-10T10:05:00Z',
        elapsedSeconds: 300,
      },
    }));

    const divergences = compareSnapshots(legacyPath, newPath);
    assert.ok(divergences.length > 0, 'Expected at least one divergence');
    const stepDivergence = divergences.find(d => d.field === 'currentStep');
    assert.ok(stepDivergence, 'Expected currentStep divergence');
    assert.equal(stepDivergence!.legacy, 'semantic_analysis');
    assert.equal(stepDivergence!.current, 'classify_entities');
  });

  it('returns empty array when either file does not exist', () => {
    const legacyPath = path.join(tmpDir, 'nonexistent-legacy.json');
    const newPath = path.join(tmpDir, 'nonexistent-new.json');

    const divergences = compareSnapshots(legacyPath, newPath);
    assert.deepEqual(divergences, []);
  });

  it('returns empty array when only legacy file exists', () => {
    const legacyPath = path.join(tmpDir, 'legacy.json');
    const newPath = path.join(tmpDir, 'nonexistent.json');

    fs.writeFileSync(legacyPath, JSON.stringify({
      status: 'running',
      currentStep: 'test',
      workflowName: 'wave-analysis',
    }));

    const divergences = compareSnapshots(legacyPath, newPath);
    assert.deepEqual(divergences, []);
  });
});
