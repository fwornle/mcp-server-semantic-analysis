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

import { writeFileSync } from 'fs';
import { transition, InvalidTransitionError } from '../../../shared/workflow-types/transitions.js';
import type { WorkflowState } from '../../../shared/workflow-types/state.js';
import type { WorkflowTransitionEvent } from '../../../shared/workflow-types/transitions.js';

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
      writeFileSync(progressFilePath, JSON.stringify(state, null, 2));
    } catch (err) {
      process.stderr.write(
        `[workflow-state-machine] Failed to write progress file: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  };
}
