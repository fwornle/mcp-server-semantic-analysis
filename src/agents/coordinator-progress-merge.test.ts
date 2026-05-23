/**
 * Unit tests for the field-preserving merge in coordinator.writeProgressFile.
 *
 * Phase 42 Plan 02 — adopt RESEARCH §2 fix #3: coordinator's progress writes
 * now read the existing file and preserve the same allowlist of fields that
 * the state-machine subscriber preserves (workflow-state-machine.ts:117-162).
 *
 * The seven tests below exercise the allowlist semantics. The function under
 * test is `preserveFromExisting(progress, progressPath)` — exported from
 * `coordinator.js` for testability (the production call site is internal to
 * writeProgressFile; the helper itself is pure and side-effect-free apart
 * from a single fs.readFileSync of the existing progress file).
 *
 * Run via:
 *   npm run build && node --test dist/agents/coordinator-progress-merge.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { preserveFromExisting } from './coordinator.js';

// ---------------------------------------------------------------------------
// Temp-directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let progressPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-progress-merge-'));
  progressPath = path.join(tmpDir, 'workflow-progress.json');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function writeExisting(obj: Record<string, unknown>): void {
  fs.writeFileSync(progressPath, JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('coordinator.preserveFromExisting — field-preserving merge', () => {
  it('Test 1: no existing file → progress returned unchanged (no read happens)', () => {
    // progressPath does not exist (beforeEach didn't create it)
    assert.equal(fs.existsSync(progressPath), false);

    const progress = {
      workflowName: 'wave-analysis',
      status: 'running',
      totalSteps: 6,
    };
    const merged = preserveFromExisting(progress, progressPath);

    // Returned object matches input verbatim (allowed: same identity OR equal shape)
    assert.deepEqual(merged, progress);
    // The merge step did not write the file
    assert.equal(fs.existsSync(progressPath), false);
  });

  it('Test 2: existing.stepPaused=true preserved when new progress omits it', () => {
    writeExisting({
      stepPaused: true,
      pausedAtStep: 'kg_operators',
      pausedAt: '2026-05-23T12:00:00.000Z',
      // Plus the usual progress fields that DON'T get preserved:
      stepsDetail: [{ name: 'old-step', status: 'completed' }],
      completedSteps: 3,
      totalSteps: 6,
    });

    const newProgress = {
      workflowName: 'wave-analysis',
      status: 'running',
      // stepPaused / pausedAtStep / pausedAt absent — preserve
      // stepsDetail / completedSteps / totalSteps present — new wins
      stepsDetail: [{ name: 'new-step', status: 'running' }],
      completedSteps: 5,
      totalSteps: 6,
    };

    const merged = preserveFromExisting(newProgress, progressPath) as Record<string, unknown>;

    assert.equal(merged.stepPaused, true);
    assert.equal(merged.pausedAtStep, 'kg_operators');
    assert.equal(merged.pausedAt, '2026-05-23T12:00:00.000Z');
    // Coordinator-owned fields: new value wins
    assert.deepEqual(merged.stepsDetail, [{ name: 'new-step', status: 'running' }]);
    assert.equal(merged.completedSteps, 5);
    assert.equal(merged.totalSteps, 6);
  });

  it('Test 3: all allowlist fields preserved when new progress omits them', () => {
    writeExisting({
      stepPaused: true,
      pausedAtStep: 'foo',
      pausedAt: '2026-05-23T11:00:00.000Z',
      mockLLM: true,
      mockLLMDelay: 100,
      singleStepMode: true,
      stepIntoSubsteps: true,
      llmState: { mode: 'mock' },
    });

    const newProgress = {
      workflowName: 'wave-analysis',
      status: 'running',
    };

    const merged = preserveFromExisting(newProgress, progressPath) as Record<string, unknown>;

    assert.equal(merged.stepPaused, true);
    assert.equal(merged.pausedAtStep, 'foo');
    assert.equal(merged.pausedAt, '2026-05-23T11:00:00.000Z');
    assert.equal(merged.mockLLM, true);
    assert.equal(merged.mockLLMDelay, 100);
    assert.equal(merged.singleStepMode, true);
    assert.equal(merged.stepIntoSubsteps, true);
    assert.deepEqual(merged.llmState, { mode: 'mock' });
  });

  it('Test 4: new progress with explicit field value wins (override semantics)', () => {
    writeExisting({
      stepPaused: true,
      mockLLM: true,
    });

    const newProgress = {
      stepPaused: false, // explicit override
      mockLLM: false,    // explicit override
    };

    const merged = preserveFromExisting(newProgress, progressPath) as Record<string, unknown>;

    // New value wins — preserve only fills gaps
    assert.equal(merged.stepPaused, false);
    assert.equal(merged.mockLLM, false);
  });

  it('Test 5: nested config.singleStepMode preserved when present in existing and absent from new', () => {
    writeExisting({
      config: {
        singleStepMode: true,
        someOtherKey: 'ignored', // not in nested allowlist, but config.singleStepMode is
      },
    });

    const newProgress = {
      // config absent entirely — preserve nested keys
    };

    const merged = preserveFromExisting(newProgress, progressPath) as Record<string, unknown>;

    assert.equal(typeof merged.config, 'object');
    assert.equal((merged.config as Record<string, unknown>).singleStepMode, true);
  });

  it('Test 6: stepsDetail / completedSteps / totalSteps NEVER preserved from existing', () => {
    writeExisting({
      stepsDetail: [{ name: 'stale-step', status: 'completed' }],
      completedSteps: 5,
      totalSteps: 6,
    });

    const newProgress = {
      workflowName: 'wave-analysis',
      status: 'running',
      // stepsDetail / completedSteps / totalSteps ABSENT
    };

    const merged = preserveFromExisting(newProgress, progressPath) as Record<string, unknown>;

    // These fields are coordinator-owned; the merge does NOT pull them from existing
    assert.equal(merged.stepsDetail, undefined);
    assert.equal(merged.completedSteps, undefined);
    assert.equal(merged.totalSteps, undefined);
    // Sanity: state-machine-owned fields are not magically synthesized either
    assert.equal(merged.stepPaused, undefined);
  });

  it('Test 7: malformed JSON in existing file → progress returned verbatim + stderr warn', () => {
    // Write invalid JSON to the existing file
    fs.writeFileSync(progressPath, '{ this is not valid JSON', 'utf8');

    const newProgress = {
      workflowName: 'wave-analysis',
      status: 'running',
    };

    // Capture stderr writes
    const stderrCalls: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => {
      stderrCalls.push(s);
      return true;
    }) as typeof process.stderr.write;

    let merged: Record<string, unknown>;
    try {
      merged = preserveFromExisting(newProgress, progressPath) as Record<string, unknown>;
    } finally {
      process.stderr.write = originalWrite;
    }

    // Verbatim fall-through: input progress is returned unchanged
    assert.deepEqual(merged, newProgress);
    // A diagnostic was emitted via stderr
    assert.equal(
      stderrCalls.some(s => s.includes('writeProgressFile') && s.includes('unreadable')),
      true,
      `expected stderr to contain a writeProgressFile diagnostic; got: ${JSON.stringify(stderrCalls)}`
    );
  });
});
