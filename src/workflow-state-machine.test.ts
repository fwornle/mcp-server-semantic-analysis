/**
 * Tests for the workflow state machine singleton.
 *
 * Covers: getState, dispatch, subscribe, reset, createProgressFileSubscriber
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { getState, dispatch, subscribe, reset, createProgressFileSubscriber } from './workflow-state-machine.js';
import { InvalidTransitionError } from './shared/workflow-types/transitions.js';
import type { WorkflowState } from './shared/workflow-types/state.js';
import type { WorkflowTransitionEvent } from './shared/workflow-types/transitions.js';

// Helper: a valid start event
function makeStartEvent(): WorkflowTransitionEvent {
  return {
    type: 'start' as const,
    config: {
      singleStepMode: false,
      mockLLM: false,
      llmMode: 'public' as const,
      stepIntoSubsteps: false,
    },
    workflowName: 'test-workflow',
    firstStep: 'init',
  };
}

describe('workflow-state-machine singleton', () => {
  beforeEach(() => {
    reset();
  });

  it('Test 1: getState() returns idle initially', () => {
    const state = getState();
    assert.equal(state.status, 'idle');
  });

  it('Test 2: dispatch(start) moves state to running', () => {
    const newState = dispatch(makeStartEvent());
    assert.equal(newState.status, 'running');
    assert.equal(getState().status, 'running');
    if (newState.status === 'running') {
      assert.equal(newState.workflowName, 'test-workflow');
      assert.equal(newState.progress.currentStepName, 'init');
    }
  });

  it('Test 3: dispatch(start) while already running throws InvalidTransitionError', () => {
    dispatch(makeStartEvent());
    assert.throws(
      () => dispatch(makeStartEvent()),
      (err: unknown) => err instanceof InvalidTransitionError
    );
  });

  it('Test 4: subscribe() callback is invoked on every dispatch with (newState, event)', () => {
    const calls: Array<{ state: WorkflowState; event: WorkflowTransitionEvent }> = [];
    subscribe((state, event) => {
      calls.push({ state, event });
    });

    const startEvent = makeStartEvent();
    dispatch(startEvent);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].state.status, 'running');
    assert.equal(calls[0].event.type, 'start');
  });

  it('Test 5: Multiple subscribers all receive notifications', () => {
    let count1 = 0;
    let count2 = 0;
    subscribe(() => { count1++; });
    subscribe(() => { count2++; });

    dispatch(makeStartEvent());

    assert.equal(count1, 1);
    assert.equal(count2, 1);
  });

  it('Test 6: reset() returns state to idle', () => {
    dispatch(makeStartEvent());
    assert.equal(getState().status, 'running');
    reset();
    assert.equal(getState().status, 'idle');
  });

  it('Test 7: Progress file subscriber writes WorkflowState JSON to disk on each transition', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
    const progressPath = path.join(tmpDir, 'workflow-progress.json');

    try {
      const unsub = subscribe(createProgressFileSubscriber(progressPath));

      dispatch(makeStartEvent());

      // Verify file was written
      assert.ok(fs.existsSync(progressPath), 'Progress file should exist');
      const written = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
      assert.equal(written.status, 'running');
      assert.equal(written.workflowName, 'test-workflow');

      unsub();
    } finally {
      // Cleanup
      try { fs.unlinkSync(progressPath); } catch { /* ignore */ }
      try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
    }
  });

  it('Test 8: dispatch(cancel) from running state moves to cancelled', () => {
    dispatch(makeStartEvent());
    const cancelledState = dispatch({ type: 'cancel', reason: 'test cancel' });
    assert.equal(cancelledState.status, 'cancelled');
    assert.equal(getState().status, 'cancelled');
  });
});
