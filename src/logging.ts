import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export type LogLevel = "debug" | "info" | "warning" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: any;
}

let logDir: string = "";
let logFile: string = "";

// Async log buffer to prevent blocking the event loop
let logBuffer: string[] = [];
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
let isWriting = false;
const FLUSH_INTERVAL_MS = 100; // Flush every 100ms
const MAX_BUFFER_SIZE = 50; // Flush when buffer has 50 entries

export function setupLogging(): void {
  // Use CODING_REPO/.data/logs/ for a stable, centralized log location.
  // Falls back to CWD only if CODING_REPO is not set.
  // Previously used process.cwd() which scattered logs/ directories into
  // whatever project the agent happened to be working in.
  const baseDir = process.env.CODING_REPO || process.cwd();
  logDir = path.join(baseDir, ".data", "logs");
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Create log file with timestamp
  const timestamp = new Date().toISOString().split('T')[0];
  logFile = path.join(logDir, `semantic-analysis-${timestamp}.log`);

  log("Logging system initialized", "info");
}

/**
 * Async flush of log buffer to file
 * Uses non-blocking file I/O to prevent event loop blocking
 */
async function flushLogBuffer(): Promise<void> {
  if (isWriting || logBuffer.length === 0 || !logFile) {
    return;
  }

  isWriting = true;
  const toWrite = logBuffer.join('');
  logBuffer = [];

  try {
    await fsp.appendFile(logFile, toWrite);
  } catch (error) {
    // Silently ignore file write errors to prevent cascading failures
    // Console.error would itself trigger more logging
  } finally {
    isWriting = false;
  }
}

/**
 * Schedule async flush of log buffer
 */
function scheduleFlush(): void {
  if (flushTimeout) return;

  flushTimeout = setTimeout(() => {
    flushTimeout = null;
    flushLogBuffer().catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

export function log(message: string, level: LogLevel = "info", data?: any): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data
  };

  // Write to stderr for debugging (visible in terminal)
  // Use minimal formatting to reduce blocking
  console.error(`[${entry.timestamp}] ${level.toUpperCase()}: ${message}`);
  if (data && (level === 'error' || level === 'warning' || message.includes('TRACE') || message.includes('SUMMARY'))) {
    // Log data for errors, warnings, and trace/summary entries
    console.error(`  Data: ${JSON.stringify(data, null, 2)}`);
  }

  // Buffer log entries for async file write
  if (logFile) {
    logBuffer.push(JSON.stringify(entry) + '\n');

    // Flush immediately if buffer is full, otherwise schedule
    if (logBuffer.length >= MAX_BUFFER_SIZE) {
      flushLogBuffer().catch(() => {});
    } else {
      scheduleFlush();
    }
  }
}

export function logRequest(method: string, params: any): void {
  log(`Request: ${method}`, "info", { params });
}

export function logResponse(method: string, response: any): void {
  log(`Response: ${method}`, "info", { response });
}

export function logError(error: Error | string, context?: string): void {
  const message = context ? `${context}: ${error}` : String(error);
  log(message, "error", error instanceof Error ? {
    name: error.name,
    message: error.message,
    stack: error.stack
  } : undefined);
}