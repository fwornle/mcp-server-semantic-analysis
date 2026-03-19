/**
 * Workflow state machine singleton.
 *
 * Central state management for workflow execution. Wraps the pure transition()
 * function from shared/workflow-types with in-memory state, subscriber
 * notification, and single-workflow enforcement.
 *
 * Exports:
 *   getState()   - Read current WorkflowState (no disk I/O)
 *   dispatch()   - Apply a transition event, notify subscribers
 *   subscribe()  - Register a callback for state changes
 *   reset()      - Return to idle (for tests and cleanup)
 *   createProgressFileSubscriber() - Factory for disk-persistence subscriber
 */

import { readFileSync, writeFileSync } from 'fs';
import { transition, InvalidTransitionError } from './shared/workflow-types/transitions.js';
import type { WorkflowState } from './shared/workflow-types/state.js';
import type { WorkflowTransitionEvent } from './shared/workflow-types/transitions.js';

// Re-export for consumer convenience
export { InvalidTransitionError };
export type { WorkflowState, WorkflowTransitionEvent };

// ---------------------------------------------------------------------------
// Module-level state (singleton)
// ---------------------------------------------------------------------------

type Subscriber = (state: WorkflowState, event: WorkflowTransitionEvent) => void;

let currentState: WorkflowState = { status: 'idle' };
const subscribers: Subscriber[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the current workflow state. No disk I/O -- purely in-memory.
 */
export function getState(): WorkflowState {
  return currentState;
}

/**
 * Apply a transition event to the current state.
 *
 * - Delegates to the pure transition() function from shared types
 * - Updates in-memory state
 * - Notifies all subscribers (errors in subscribers are caught individually)
 * - Lets InvalidTransitionError propagate to caller
 *
 * @returns The new WorkflowState after transition
 */
export function dispatch(event: WorkflowTransitionEvent): WorkflowState {
  // transition() may throw InvalidTransitionError -- let it propagate
  const newState = transition(currentState, event);
  currentState = newState;

  // Notify subscribers -- catch errors individually so one bad subscriber
  // doesn't block others or break the state machine
  for (const sub of subscribers) {
    try {
      sub(newState, event);
    } catch (err) {
      process.stderr.write(
        `[workflow-state-machine] Subscriber error: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  return newState;
}

/**
 * Register a subscriber that is called on every state transition.
 *
 * @param fn Callback receiving (newState, event) after each dispatch
 * @returns Unsubscribe function -- call to remove the subscriber
 */
export function subscribe(fn: Subscriber): () => void {
  subscribers.push(fn);
  return () => {
    const idx = subscribers.indexOf(fn);
    if (idx !== -1) {
      subscribers.splice(idx, 1);
    }
  };
}

/**
 * Reset state machine to idle. Used for:
 * - Test cleanup between test cases
 * - Explicit reset after terminal states (failed/completed/cancelled)
 *
 * Also clears all subscribers to prevent leaks in test scenarios.
 */
export function reset(): void {
  currentState = { status: 'idle' };
  subscribers.length = 0;
}

// ---------------------------------------------------------------------------
// Progress file subscriber
// ---------------------------------------------------------------------------

/**
 * Create a subscriber that writes the full WorkflowState to a JSON file
 * on every state transition. Used to persist state for the dashboard and
 * crash recovery.
 *
 * Errors are logged to stderr but never thrown -- subscriber errors must
 * not break the state machine.
 *
 * @param progressFilePath Absolute path to the progress JSON file
 */
export function createProgressFileSubscriber(progressFilePath: string): Subscriber {
  return (state: WorkflowState, _event: WorkflowTransitionEvent): void => {
    try {
      // Merge with existing file to preserve fields that live outside state machine state:
      // - wave-controller pause fields (stepPaused, pausedAtStep, pausedAt)
      // - debug/mock fields (mockLLM, singleStepMode, stepIntoSubsteps, llmState)
      //   These are pre-written by tools.ts and read by isMockLLMEnabled() at top level
      let merged: Record<string, unknown> = { ...state } as Record<string, unknown>;
      try {
        const existing = JSON.parse(readFileSync(progressFilePath, 'utf8'));
        // Preserve pause state
        if (existing.stepPaused !== undefined) {
          merged.stepPaused = existing.stepPaused;
          merged.pausedAtStep = existing.pausedAtStep;
          merged.pausedAt = existing.pausedAt;
        }
        // Preserve top-level debug fields (read by isMockLLMEnabled, wave-controller, dashboard)
        // IMPORTANT: Top-level fields are authoritative (set by user actions via REST/WS).
        // Also sync them INTO config so both paths in wave-controller agree.
        if (existing.mockLLM !== undefined) merged.mockLLM = existing.mockLLM;
        if (existing.mockLLMDelay !== undefined) merged.mockLLMDelay = existing.mockLLMDelay;
        // singleStepMode and stepIntoSubsteps: preserve existing top-level values
        // AND ensure config matches (wave-controller reads top-level as authoritative)
        if (existing.singleStepMode !== undefined) merged.singleStepMode = existing.singleStepMode;
        if (existing.stepIntoSubsteps !== undefined) merged.stepIntoSubsteps = existing.stepIntoSubsteps;
        // Sync config to match top-level (prevents config from reverting user changes)
        if (merged.config && typeof merged.config === 'object') {
          const cfg = merged.config as Record<string, unknown>;
          if (existing.singleStepMode !== undefined) cfg.singleStepMode = existing.singleStepMode;
          if (existing.stepIntoSubsteps !== undefined) cfg.stepIntoSubsteps = existing.stepIntoSubsteps;
        }
        if (existing.llmState !== undefined) merged.llmState = existing.llmState;
      } catch {
        // File doesn't exist yet or unreadable — write fresh
      }
      // Always write a top-level lastUpdate for the dashboard health check
      // (progress.lastUpdate is nested inside the state machine state)
      merged.lastUpdate = ('progress' in state ? (state.progress as any)?.lastUpdate : null) || new Date().toISOString();
      writeFileSync(progressFilePath, JSON.stringify(merged, null, 2));
    } catch (err) {
      process.stderr.write(
        `[workflow-state-machine] Failed to write progress file: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  };
}
