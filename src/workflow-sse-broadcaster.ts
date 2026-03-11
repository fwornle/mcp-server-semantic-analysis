/**
 * SSE broadcaster for workflow state events.
 *
 * Subscribes to the state machine and relays typed WorkflowSSEEvents
 * to connected SSE clients in text/event-stream format.
 *
 * Usage:
 *   const broadcaster = createSSEBroadcaster();
 *   subscribe(broadcaster.subscriber.bind(broadcaster));
 *   // In /workflow-events handler:
 *   broadcaster.addClient(res, getState());
 *   req.on('close', () => broadcaster.removeClient(res));
 */

import type { WorkflowSSEEvent } from './shared/workflow-types/events.js';
import type { WorkflowState } from './shared/workflow-types/state.js';
import type { WorkflowTransitionEvent } from './shared/workflow-types/transitions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal writable interface for SSE clients (testable without full Express Response) */
interface SSEWritable {
  write(chunk: string): boolean;
  writableEnded: boolean;
  destroyed: boolean;
}

// ---------------------------------------------------------------------------
// SSEBroadcaster
// ---------------------------------------------------------------------------

export class SSEBroadcaster {
  private clients: Set<SSEWritable> = new Set();

  /**
   * Add a connected SSE client and immediately send the current state.
   */
  addClient(res: SSEWritable, currentState: WorkflowState): void {
    this.clients.add(res);

    const initialEvent: WorkflowSSEEvent = {
      event: 'initial-state',
      state: currentState,
      timestamp: new Date().toISOString(),
    };
    this.writeSSE(res, 'initial-state', initialEvent);
  }

  /**
   * Remove a disconnected SSE client.
   */
  removeClient(res: SSEWritable): void {
    this.clients.delete(res);
  }

  /**
   * Number of currently connected SSE clients.
   */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * State machine subscriber callback.
   *
   * Pass to subscribe(): `subscribe(broadcaster.subscriber.bind(broadcaster))`
   *
   * Formats a state-change event and writes to all connected clients.
   * Catches per-client write errors and removes dead clients.
   */
  subscriber(state: WorkflowState, event: WorkflowTransitionEvent): void {
    const sseEvent: WorkflowSSEEvent = {
      event: 'state-change',
      state,
      transition: event.type,
      timestamp: new Date().toISOString(),
    };

    const dead: SSEWritable[] = [];

    for (const client of this.clients) {
      if (client.writableEnded || client.destroyed) {
        dead.push(client);
        continue;
      }

      try {
        this.writeSSE(client, 'state-change', sseEvent);
      } catch {
        dead.push(client);
      }
    }

    // Remove dead clients after iteration
    for (const client of dead) {
      this.clients.delete(client);
    }
  }

  /**
   * Write an SSE-formatted message to a client.
   *
   * Format: event: {type}\ndata: {json}\n\n
   */
  private writeSSE(client: SSEWritable, eventType: string, data: WorkflowSSEEvent): void {
    const chunk = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    client.write(chunk);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new SSEBroadcaster instance.
 */
export function createSSEBroadcaster(): SSEBroadcaster {
  return new SSEBroadcaster();
}
