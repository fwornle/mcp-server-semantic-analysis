/**
 * Tests for SSE event types and the WorkflowSSE broadcaster.
 *
 * Covers:
 *   - WorkflowSSEEventSchema validation (state-change, initial-state, rejection)
 *   - Broadcaster SSE formatting, client management, error handling
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowSSEEventSchema } from './shared/workflow-types/events.js';
import { createSSEBroadcaster } from './workflow-sse-broadcaster.js';
import type { WorkflowState } from './shared/workflow-types/state.js';
import type { WorkflowTransitionEvent } from './shared/workflow-types/transitions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock response with .write(), .writableEnded, .destroyed */
function createMockResponse(): {
  write: (chunk: string) => boolean;
  writableEnded: boolean;
  destroyed: boolean;
  chunks: string[];
} {
  const chunks: string[] = [];
  return {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
    writableEnded: false,
    destroyed: false,
    chunks,
  };
}

/** A valid idle state */
const idleState: WorkflowState = { status: 'idle' };

/** A valid running state for testing */
const runningState: WorkflowState = {
  status: 'running',
  subStatus: 'executing-step',
  workflowId: 'wf-123',
  workflowName: 'test-workflow',
  config: {
    singleStepMode: false,
    mockLLM: false,
    llmMode: 'public' as const,
    stepIntoSubsteps: false,
  },
  progress: {
    currentStepIndex: 1,
    currentStepName: 'analyze',
    completedSteps: ['init'],
    startTime: '2026-03-11T00:00:00Z',
    lastUpdate: '2026-03-11T00:01:00Z',
    elapsedSeconds: 60,
  },
};

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe('WorkflowSSEEventSchema', () => {
  it('Test 1: validates a state-change event with WorkflowState payload', () => {
    const event = {
      event: 'state-change',
      state: runningState,
      transition: 'step-complete',
      timestamp: '2026-03-11T00:01:00Z',
    };
    const result = WorkflowSSEEventSchema.safeParse(event);
    assert.ok(result.success, `Should validate state-change event: ${JSON.stringify(result.error?.issues)}`);
    if (result.success) {
      assert.equal(result.data.event, 'state-change');
      assert.equal(result.data.state.status, 'running');
    }
  });

  it('Test 2: validates an initial-state event (sent on connect)', () => {
    const event = {
      event: 'initial-state',
      state: idleState,
      timestamp: '2026-03-11T00:00:00Z',
    };
    const result = WorkflowSSEEventSchema.safeParse(event);
    assert.ok(result.success, `Should validate initial-state event: ${JSON.stringify(result.error?.issues)}`);
    if (result.success) {
      assert.equal(result.data.event, 'initial-state');
      assert.equal(result.data.state.status, 'idle');
    }
  });

  it('Test 3: rejects unknown event types', () => {
    const event = {
      event: 'unknown-type',
      state: idleState,
      timestamp: '2026-03-11T00:00:00Z',
    };
    const result = WorkflowSSEEventSchema.safeParse(event);
    assert.ok(!result.success, 'Should reject unknown event type');
  });
});

// ---------------------------------------------------------------------------
// Broadcaster tests
// ---------------------------------------------------------------------------

describe('SSEBroadcaster', () => {
  it('Test 4: subscriber formats events as SSE text/event-stream lines', () => {
    const broadcaster = createSSEBroadcaster();
    const res = createMockResponse();

    // Add client first (consumes the initial-state write)
    broadcaster.addClient(res, idleState);
    const initialChunks = res.chunks.length;

    // Simulate a state transition
    const event: WorkflowTransitionEvent = {
      type: 'step-complete',
      stepName: 'init',
      nextStep: 'analyze',
      duration: 5,
    };
    broadcaster.subscriber(runningState, event);

    // Should have one more chunk (the state-change SSE event)
    assert.equal(res.chunks.length, initialChunks + 1);
    const sseChunk = res.chunks[res.chunks.length - 1];

    // Verify SSE format: "event: state-change\ndata: {...}\n\n"
    assert.ok(sseChunk.startsWith('event: state-change\n'), `Should start with event line, got: ${sseChunk.slice(0, 40)}`);
    assert.ok(sseChunk.includes('data: '), 'Should contain data line');
    assert.ok(sseChunk.endsWith('\n\n'), 'Should end with double newline');

    // Verify data is valid JSON with correct structure
    const dataLine = sseChunk.split('\n').find(l => l.startsWith('data: '));
    assert.ok(dataLine, 'Should have a data line');
    const parsed = JSON.parse(dataLine!.slice(6));
    assert.equal(parsed.event, 'state-change');
    assert.equal(parsed.transition, 'step-complete');
    assert.equal(parsed.state.status, 'running');
  });

  it('Test 5: addClient/removeClient tracks connected response objects', () => {
    const broadcaster = createSSEBroadcaster();
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    assert.equal(broadcaster.clientCount, 0);

    broadcaster.addClient(res1, idleState);
    assert.equal(broadcaster.clientCount, 1);

    broadcaster.addClient(res2, idleState);
    assert.equal(broadcaster.clientCount, 2);

    broadcaster.removeClient(res1);
    assert.equal(broadcaster.clientCount, 1);

    broadcaster.removeClient(res2);
    assert.equal(broadcaster.clientCount, 0);
  });

  it('Test 6: addClient sends initial-state event with current WorkflowState', () => {
    const broadcaster = createSSEBroadcaster();
    const res = createMockResponse();

    broadcaster.addClient(res, runningState);

    assert.equal(res.chunks.length, 1, 'Should have written one SSE event on connect');
    const sseChunk = res.chunks[0];

    assert.ok(sseChunk.startsWith('event: initial-state\n'), `Should be initial-state event, got: ${sseChunk.slice(0, 40)}`);

    const dataLine = sseChunk.split('\n').find(l => l.startsWith('data: '));
    const parsed = JSON.parse(dataLine!.slice(6));
    assert.equal(parsed.event, 'initial-state');
    assert.equal(parsed.state.status, 'running');
    assert.equal(parsed.state.workflowName, 'test-workflow');
  });

  it('Test 7: handles client write errors gracefully (removes dead clients)', () => {
    const broadcaster = createSSEBroadcaster();
    const goodRes = createMockResponse();
    const deadRes = createMockResponse();

    broadcaster.addClient(goodRes, idleState);
    broadcaster.addClient(deadRes, idleState);
    assert.equal(broadcaster.clientCount, 2);

    // Make deadRes throw on write
    deadRes.write = () => { throw new Error('Connection closed'); };

    // Trigger a state-change event
    const event: WorkflowTransitionEvent = {
      type: 'step-complete',
      stepName: 'init',
      nextStep: 'analyze',
      duration: 5,
    };
    broadcaster.subscriber(runningState, event);

    // Dead client should be removed, good client should receive the event
    assert.equal(broadcaster.clientCount, 1);
    // Good client should have initial-state + state-change = 2 chunks
    assert.equal(goodRes.chunks.length, 2);
  });
});
