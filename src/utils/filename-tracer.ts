/**
 * Comprehensive filename tracing utility
 * Tracks every filename operation to find corruption source
 */

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
    
    console.error(`🔍 FILENAME TRACE [${step}] at ${location}:`);
    console.error(`   INPUT:  ${trace.input}`);
    console.error(`   OUTPUT: ${trace.output}`);
    console.error(`   STACK:  ${trace.stackTrace.split('\n')[0]}`);
    
    // Detect corruption immediately
    if (typeof output === 'string' && output.includes('documentationupdates')) {
      console.error(`🚨 CORRUPTION DETECTED at ${location}!`);
      console.error(`   Corrupted output: ${output}`);
      console.error(`   Full stack: ${trace.stackTrace}`);
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
    console.error('\n📋 FILENAME TRACE SUMMARY:');
    console.error(`Total traces: ${this.traces.length}`);
    
    const corrupted = this.getCorruptionTraces();
    if (corrupted.length > 0) {
      console.error(`🚨 CORRUPTION FOUND in ${corrupted.length} traces:`);
      corrupted.forEach((trace, i) => {
        console.error(`  ${i + 1}. ${trace.step} at ${trace.location}: ${trace.output}`);
      });
    } else {
      console.error('✅ No corruption detected in traces');
    }
  }

  static clear() {
    this.traces = [];
  }
}

export { FilenameTracer };