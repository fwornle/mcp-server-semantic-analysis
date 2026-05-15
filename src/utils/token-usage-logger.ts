/**
 * Centralized Token Usage Logger
 * 
 * Hooks into LLMService 'complete' events and persists token usage
 * to the shared SQLite DB used by the LLM proxy bridge.
 * Ensures ALL cognitive processes (wave agents, insight generators, etc.)
 * are tracked in the same token-usage dashboard.
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';
import type { EventEmitter } from 'events';

const CODING_ROOT = process.env.CODING_ROOT || '/Users/Q284340/Agentic/coding';
const DB_PATH = resolve(CODING_ROOT, '.observations', 'token-usage.db');

let db: ReturnType<typeof Database> | null = null;
let insertStmt: any = null;

function ensureDb(): void {
  if (db) return;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        process TEXT NOT NULL DEFAULT 'unknown',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        subscription TEXT DEFAULT '',
        prompt_preview TEXT DEFAULT ''
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_process ON token_usage(process)`);
    insertStmt = db.prepare(`
      INSERT INTO token_usage (timestamp, provider, model, process, input_tokens, output_tokens, total_tokens, latency_ms, subscription, prompt_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  } catch (err) {
    console.warn('[token-logger] Failed to initialize SQLite:', (err as Error).message);
  }
}

/**
 * Log a single token usage entry
 */
export function logTokenUsage(entry: {
  provider: string;
  model: string;
  process: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  subscription?: string;
  promptPreview?: string;
}): void {
  try {
    ensureDb();
    if (!insertStmt) return;
    
    // Derive subscription from provider
    const subscription = entry.subscription || deriveSubscription(entry.provider);
    
    insertStmt.run(
      new Date().toISOString(),
      entry.provider,
      entry.model,
      entry.process,
      entry.inputTokens,
      entry.outputTokens,
      entry.totalTokens,
      entry.latencyMs,
      subscription,
      (entry.promptPreview || '').slice(0, 200)
    );
  } catch (err) {
    // Silent — token logging must never break the main flow
  }
}

function deriveSubscription(provider: string): string {
  switch (provider) {
    case 'copilot': return 'copilot-subscription';
    case 'claude-code': return 'max-subscription';
    case 'anthropic': return 'api-key-anthropic';
    case 'openai': return 'api-key-openai';
    case 'groq': return 'api-key-groq';
    default: return provider;
  }
}

/**
 * Attach token logging to an LLMService instance.
 * Listens to the 'complete' event emitted after every LLM call.
 * 
 * @param llmService - LLMService instance (EventEmitter)
 * @param processName - Cognitive process name (e.g. 'wave1-project-agent')
 */
export function attachTokenLogger(llmService: EventEmitter, processName: string): void {
  llmService.on('complete', (event: {
    mode?: string;
    provider?: string;
    model?: string;
    tokens?: { input: number; output: number; total: number };
    latencyMs?: number;
    operationType?: string;
  }) => {
    if (event.mode === 'mock') return; // Don't log mock calls
    
    logTokenUsage({
      provider: event.provider || event.mode || 'unknown',
      model: event.model || 'unknown',
      process: processName,
      inputTokens: event.tokens?.input || 0,
      outputTokens: event.tokens?.output || 0,
      totalTokens: event.tokens?.total || 0,
      latencyMs: event.latencyMs || 0,
    });
  });
}
