/**
 * Phase 42 Plan 07 — SC#4 single-writer terminal-state guarantee.
 *
 * `writeTerminalState(progressFile, status, summary?, error?)` synchronously
 * writes the terminal-state JSON to the workflow progress file, preserving
 * the field allowlist owned by other writers (state-machine subscriber's
 * user-control fields: pause flags + debug flags + llmState).
 *
 * The helper is invoked by workflow-runner.ts immediately before
 * `process.exit()` in BOTH the success and failure paths of the
 * wave-analysis branch. This is the "single-writer terminal-state"
 * remediation prescribed by RESEARCH §2 fix #1.
 *
 * Why this exists:
 *
 * The state-machine subscriber writes the progress file on every transition,
 * but `dispatch({type:'complete'})` may throw InvalidTransitionError when
 * the state machine has drifted (which the existing catch silently swallows
 * in workflow-runner.ts:480 + 506). When that happens, NO terminal-state
 * write ever fires and the dashboard reads `status: 'running'` from a stale
 * file long after the process has exited (the failure mode captured in
 * 42-02-VERIFY-FAIL.md at 12:35:07Z — process gone, file still 'running'
 * for 12+ minutes).
 *
 * This helper is the synchronous belt-and-braces guarantee: regardless of
 * whether dispatch succeeded, the terminal-state will be on disk before
 * process.exit().
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/**
 * Field allowlist that other writers own — these are user-control fields
 * managed via the REST/WS surface and the dashboard. The terminal write
 * must NOT clobber them. Mirrors workflow-state-machine.ts:117-162.
 */
const PRESERVE_FIELDS = [
  'stepPaused',
  'pausedAtStep',
  'pausedAt',
  'mockLLM',
  'mockLLMDelay',
  'singleStepMode',
  'stepIntoSubsteps',
  'llmState',
  'workflowId',
  'startTime',
  'config',
] as const;

export type TerminalStatus = 'completed' | 'failed' | 'cancelled';

export interface TerminalSummary {
  totalEntities?: number;
  waves?: number;
  message?: string;
  [k: string]: unknown;
}

export interface TerminalError {
  error: string;
  step?: string;
  [k: string]: unknown;
}

/**
 * Synchronously write the terminal-state progress JSON.
 *
 * @param progressFile Absolute path to the workflow-progress.json file.
 * @param status Terminal status. Must be one of: completed | failed | cancelled.
 * @param summary Optional summary payload (success path).
 * @param errorPayload Optional error payload (failure path).
 *
 * Contract:
 *   - Writes synchronously (writeFileSync) so the file is on disk before
 *     the call returns; no microtask hop.
 *   - Preserves PRESERVE_FIELDS from the existing file if it exists.
 *   - Writes a fresh file if none exists.
 *   - Sets status, lastUpdate, and the summary/error payload as
 *     appropriate. Catches its own errors and writes them to stderr so
 *     a write failure during process exit does not throw and abort
 *     cleanup further upstream.
 */
export function writeTerminalState(
  progressFile: string,
  status: TerminalStatus,
  summary?: TerminalSummary,
  errorPayload?: TerminalError,
): void {
  try {
    const merged: Record<string, unknown> = {};

    if (existsSync(progressFile)) {
      try {
        const existing = JSON.parse(readFileSync(progressFile, 'utf8'));
        for (const k of PRESERVE_FIELDS) {
          if (existing[k] !== undefined) {
            merged[k] = existing[k];
          }
        }
      } catch (readErr) {
        // Unreadable existing file — proceed with fresh write.
        process.stderr.write(
          `[workflow-runner-terminal-write] existing file unreadable, writing fresh: ${
            readErr instanceof Error ? readErr.message : String(readErr)
          }\n`,
        );
      }
    }

    merged.status = status;
    merged.lastUpdate = new Date().toISOString();
    if (summary !== undefined) {
      merged.summary = summary;
    }
    if (errorPayload !== undefined) {
      // Spread the error payload so 'error' and 'step' land as top-level
      // fields for the dashboard to display directly.
      Object.assign(merged, errorPayload);
    }

    writeFileSync(progressFile, JSON.stringify(merged, null, 2));
  } catch (writeErr) {
    // The terminal write is best-effort — surface to stderr but never throw
    // (otherwise process.exit cleanup paths may abort).
    process.stderr.write(
      `[workflow-runner-terminal-write] terminal write failed: ${
        writeErr instanceof Error ? writeErr.message : String(writeErr)
      }\n`,
    );
  }
}
