/**
 * Comparison utility for migration parallel validation.
 *
 * Compares the legacy progress file (written by coordinator's writeProgressFile)
 * against the new progress file (written by state machine subscriber) to detect
 * divergences during the migration period.
 *
 * Field mapping accounts for the structural difference:
 *   Legacy: flat keys (status, currentStep, stepsCompleted, totalSteps, workflowName)
 *   New: nested structure (status, progress.currentStepName, progress.currentStepIndex, ...)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Divergence {
  /** The logical field being compared (uses legacy field name for clarity) */
  field: string;
  /** Value from the legacy progress file */
  legacy: unknown;
  /** Value from the new progress file */
  current: unknown;
}

interface ComparisonLogEntry {
  timestamp: string;
  divergences: Divergence[];
  legacyPath: string;
  newPath: string;
}

// ---------------------------------------------------------------------------
// Field mapping: legacy flat key -> how to extract equivalent from new format
// ---------------------------------------------------------------------------

interface FieldMapping {
  /** Legacy flat key name */
  legacyKey: string;
  /** Dot-delimited path in the new-format object */
  newPath: string;
  /** Optional transform to normalize legacy value before comparison */
  normalizeLegacy?: (val: unknown) => unknown;
}

const FIELD_MAPPINGS: FieldMapping[] = [
  {
    legacyKey: 'status',
    newPath: 'status',
    // Legacy 'starting' maps to new 'running'
    normalizeLegacy: (val) => (val === 'starting' ? 'running' : val),
  },
  {
    legacyKey: 'currentStep',
    newPath: 'progress.currentStepName',
  },
  {
    legacyKey: 'workflowName',
    newPath: 'workflowName',
  },
  {
    legacyKey: 'stepsCompleted',
    newPath: 'progress.currentStepIndex',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Access a nested value using a dot-delimited path.
 * e.g., getNestedValue({ progress: { currentStepName: 'foo' } }, 'progress.currentStepName') => 'foo'
 */
function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare legacy and new progress snapshots for divergences.
 *
 * Reads both files, maps legacy flat fields to their new-format equivalents,
 * and returns an array of divergences where the values don't match.
 *
 * Returns empty array if either file doesn't exist (not an error condition
 * during the migration period -- one file may not have been written yet).
 */
export function compareSnapshots(legacyPath: string, newPath: string): Divergence[] {
  // If either file is missing, no divergence can be determined
  if (!existsSync(legacyPath) || !existsSync(newPath)) {
    return [];
  }

  let legacyData: Record<string, unknown>;
  let newData: Record<string, unknown>;

  try {
    legacyData = JSON.parse(readFileSync(legacyPath, 'utf8'));
  } catch {
    return [];
  }

  try {
    newData = JSON.parse(readFileSync(newPath, 'utf8'));
  } catch {
    return [];
  }

  const divergences: Divergence[] = [];

  for (const mapping of FIELD_MAPPINGS) {
    let legacyVal = legacyData[mapping.legacyKey];
    if (mapping.normalizeLegacy) {
      legacyVal = mapping.normalizeLegacy(legacyVal);
    }

    const newVal = getNestedValue(newData, mapping.newPath);

    // Skip comparison if either value is undefined (field not present in snapshot)
    if (legacyVal === undefined || newVal === undefined) {
      continue;
    }

    // Compare as JSON strings to handle non-primitive types uniformly
    if (JSON.stringify(legacyVal) !== JSON.stringify(newVal)) {
      divergences.push({
        field: mapping.legacyKey,
        legacy: legacyVal,
        current: newVal,
      });
    }
  }

  return divergences;
}

/**
 * Append a timestamped comparison result to the comparison log file.
 *
 * The log is a JSON array of ComparisonLogEntry objects. Each workflow
 * completion adds one entry. The health API reads the latest entry.
 */
export function writeComparisonLog(
  divergences: Divergence[],
  outputPath: string,
  legacyPath: string,
  newPath: string
): void {
  const entry: ComparisonLogEntry = {
    timestamp: new Date().toISOString(),
    divergences,
    legacyPath,
    newPath,
  };

  let log: ComparisonLogEntry[] = [];
  if (existsSync(outputPath)) {
    try {
      log = JSON.parse(readFileSync(outputPath, 'utf8'));
      if (!Array.isArray(log)) {
        log = [];
      }
    } catch {
      log = [];
    }
  } else {
    // Ensure parent directory exists
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  log.push(entry);
  writeFileSync(outputPath, JSON.stringify(log, null, 2));
}
