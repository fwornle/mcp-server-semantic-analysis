/**
 * Phase 42 Plan 07 — SC#4 single-writer terminal-state guarantee.
 *
 * Background: SC#4 (the "dashboard reflects terminal state within 5s of
 * process exit" success criterion) failed during Plan 2's verification:
 * `.data/workflow-progress.json` stayed `status: 'running'` for 12+
 * minutes after the workflow-runner process had already exited
 * (42-02-VERIFY-FAIL.md). RESEARCH §2 fix #1 prescribed the "single-writer
 * architecture" remediation — funnel all terminal-state writes through
 * one code path that runs synchronously immediately before process.exit().
 *
 * This test pins the contract of the helper that lands the synchronous
 * terminal-state write: `writeTerminalState(progressFile, status,
 * summary?, error?)` reads the current progress JSON, merges the terminal
 * fields onto it WITHOUT touching the existing fields preserved by the
 * state-machine subscriber (pause flags, debug flags, llmState), and
 * writes the result back to disk synchronously.
 *
 * It is the responsibility of the wave-analysis branch in workflow-runner
 * to invoke this helper before `process.exit()`, after the `dispatch`
 * (which may have throw'd InvalidTransitionError and silently been
 * swallowed — the canonical Plan 2 failure mode).
 *
 * Run via: `npm run build && node --test dist/workflow-runner-terminal-write.test.js`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { writeTerminalState } from './workflow-runner-terminal-write.js';

function mkTmpFile(initial: Record<string, unknown> | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-terminal-write-'));
  const file = path.join(dir, 'workflow-progress.json');
  if (initial !== null) {
    fs.writeFileSync(file, JSON.stringify(initial, null, 2));
  }
  return file;
}

describe('Phase 42 Plan 07 — writeTerminalState (SC#4 single-writer fix)', () => {
  it('Test SC4-1: writes terminal status=completed onto an existing running file', () => {
    const file = mkTmpFile({
      status: 'running',
      workflowId: 'wf-test-1',
      startTime: '2026-05-23T00:00:00.000Z',
      progress: { currentStepName: 'wave1_init' },
    });

    writeTerminalState(file, 'completed', {
      totalEntities: 800,
      waves: 3,
      message: 'Wave analysis completed: 800 entities across 3 waves',
    });

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.status, 'completed', 'top-level status set to completed');
    assert.equal(typeof after.lastUpdate, 'string', 'lastUpdate populated');
    assert.deepEqual(
      after.summary,
      {
        totalEntities: 800,
        waves: 3,
        message: 'Wave analysis completed: 800 entities across 3 waves',
      },
      'summary payload persisted',
    );
    assert.equal(
      after.workflowId,
      'wf-test-1',
      'workflowId is preserved from the existing file',
    );
  });

  it('Test SC4-2: writes terminal status=failed with error payload', () => {
    const file = mkTmpFile({
      status: 'running',
      workflowId: 'wf-test-2',
      progress: { currentStepName: 'wave2_init' },
    });

    writeTerminalState(file, 'failed', undefined, {
      error: 'wave2 dedup threw',
      step: 'wave-analysis',
    });

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.status, 'failed');
    assert.equal(after.error, 'wave2 dedup threw');
    assert.equal(after.step, 'wave-analysis');
    assert.equal(after.workflowId, 'wf-test-2');
  });

  it('Test SC4-3: preserves pause + debug fields written by other writers', () => {
    const file = mkTmpFile({
      status: 'running',
      workflowId: 'wf-test-3',
      stepPaused: true,
      pausedAtStep: 'wave2_dedup',
      pausedAt: '2026-05-23T00:00:00.000Z',
      mockLLM: false,
      singleStepMode: false,
      stepIntoSubsteps: true,
      llmState: { globalMode: 'public' },
    });

    writeTerminalState(file, 'completed');

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.status, 'completed');
    // The state-machine subscriber's allowlist must be honored — these
    // are user-control fields owned by other writers (tools.ts /
    // dashboard REST) and must not be clobbered by the terminal write.
    assert.equal(after.stepPaused, true);
    assert.equal(after.pausedAtStep, 'wave2_dedup');
    assert.equal(after.pausedAt, '2026-05-23T00:00:00.000Z');
    assert.equal(after.mockLLM, false);
    assert.equal(after.singleStepMode, false);
    assert.equal(after.stepIntoSubsteps, true);
    assert.deepEqual(after.llmState, { globalMode: 'public' });
  });

  it('Test SC4-4: is idempotent — running it twice with the same status is a no-op (apart from lastUpdate)', () => {
    const file = mkTmpFile({
      status: 'running',
      workflowId: 'wf-test-4',
    });

    writeTerminalState(file, 'completed', { totalEntities: 100 });
    const firstPass = JSON.parse(fs.readFileSync(file, 'utf8'));

    // Force a small delay so lastUpdate can differ.
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    return sleep(10).then(() => {
      writeTerminalState(file, 'completed', { totalEntities: 100 });
      const secondPass = JSON.parse(fs.readFileSync(file, 'utf8'));

      assert.equal(firstPass.status, 'completed');
      assert.equal(secondPass.status, 'completed');
      assert.deepEqual(firstPass.summary, secondPass.summary);
      assert.equal(firstPass.workflowId, secondPass.workflowId);
      // lastUpdate may differ — but the rest is stable.
    });
  });

  it('Test SC4-5: writes a fresh file when none exists (no read-modify required)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-terminal-write-fresh-'));
    const file = path.join(dir, 'workflow-progress.json');
    assert.equal(fs.existsSync(file), false);

    writeTerminalState(file, 'completed', { totalEntities: 50 });

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.status, 'completed');
    assert.deepEqual(after.summary, { totalEntities: 50 });
    assert.equal(typeof after.lastUpdate, 'string');
  });

  it('Test SC4-6: is synchronous — file is on disk before the call returns', () => {
    const file = mkTmpFile({ status: 'running', workflowId: 'wf-test-6' });

    writeTerminalState(file, 'completed', { totalEntities: 1 });

    // Synchronous contract: we read immediately, without await, and expect
    // the terminal status. No microtask delay. This is the SC#4 invariant:
    // the write must complete BEFORE process.exit() in workflow-runner.
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.status, 'completed');
  });
});

// ---------------------------------------------------------------------------
// Section: Wire-up assertion — workflow-runner imports + invokes the helper.
// ---------------------------------------------------------------------------

describe('Phase 42 Plan 07 — workflow-runner wires writeTerminalState before exit', () => {
  it('Test SC4-7: workflow-runner.ts imports writeTerminalState and calls it in wave-analysis branches', () => {
    const src = fs.readFileSync(
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        'src',
        'workflow-runner.ts',
      ),
      'utf8',
    );
    // Wire-up: import is present.
    assert.match(
      src,
      /from\s+['"]\.\/workflow-runner-terminal-write(\.js)?['"]/,
      'workflow-runner.ts imports from workflow-runner-terminal-write',
    );
    assert.match(
      src,
      /\bwriteTerminalState\b/,
      'workflow-runner.ts references writeTerminalState',
    );
    // The helper must be called on BOTH the success and the failure paths
    // of the wave-analysis branch (before process.exit). We expect at least
    // two invocations.
    const calls = src.match(/writeTerminalState\(/g) ?? [];
    assert.ok(
      calls.length >= 2,
      `expected ≥2 writeTerminalState() call sites in wave-analysis branch, found ${calls.length}`,
    );
  });
});
