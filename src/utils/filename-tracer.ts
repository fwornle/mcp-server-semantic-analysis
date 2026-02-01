/**
 * Comprehensive filename tracing utility
 * Tracks every filename operation to find corruption source
 */

import { log } from '../logging.js';

interface FilenameTrace {
  step: string;
  location: string;
  input: any;
  output: any;
  timestamp: string;
  stackTrace: string;
}

class FilenameTracer {
  private static traces: FilenameTrace[] = [];
  private static enabled = process.env.SEMANTIC_ANALYSIS_DEBUG === 'true';

  static trace(step: string, location: string, input: any, output: any) {
    if (!this.enabled) return;

    const trace: FilenameTrace = {
      step,
      location,
      input: JSON.stringify(input),
      output: JSON.stringify(output),
      timestamp: new Date().toISOString(),
      stackTrace: new Error().stack?.split('\n').slice(2, 6).join('\n') || 'No stack'
    };

    this.traces.push(trace);

    log(`FILENAME TRACE [${step}] at ${location}`, 'debug', {
      input: trace.input,
      output: trace.output,
      stack: trace.stackTrace.split('\n')[0]
    });

    // Detect corruption immediately
    if (typeof output === 'string' && output.includes('documentationupdates')) {
      log(`CORRUPTION DETECTED at ${location}!`, 'error', {
        corruptedOutput: output,
        fullStack: trace.stackTrace
      });
    }
  }

  static getAllTraces(): FilenameTrace[] {
    return [...this.traces];
  }

  static getCorruptionTraces(): FilenameTrace[] {
    return this.traces.filter(t => 
      t.output.includes('documentationupdates') || 
      t.output.includes('PatternDocumentationupdatespattern')
    );
  }

  static printSummary() {
    log(`FILENAME TRACE SUMMARY: Total traces: ${this.traces.length}`, 'info');

    const corrupted = this.getCorruptionTraces();
    if (corrupted.length > 0) {
      log(`CORRUPTION FOUND in ${corrupted.length} traces`, 'error', {
        traces: corrupted.map((trace, i) => `${i + 1}. ${trace.step} at ${trace.location}: ${trace.output}`)
      });
    } else {
      log('No corruption detected in traces', 'info');
    }
  }

  static clear() {
    this.traces = [];
  }
}

export { FilenameTracer };