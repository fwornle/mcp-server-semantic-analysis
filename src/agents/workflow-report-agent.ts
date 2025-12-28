/**
 * Workflow Report Agent
 *
 * Generates detailed markdown reports for each workflow execution
 * showing inputs, outputs, and decisions made at each stage.
 *
 * Reports are stored in: .data/workflow-reports/
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';

export interface StepReport {
  stepName: string;
  agent: string;
  action: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  status: 'success' | 'failed' | 'skipped';
  inputs: Record<string, any>;
  outputs: Record<string, any>;
  decisions: string[];
  warnings: string[];
  errors: string[];
}

export interface WorkflowReport {
  workflowName: string;
  executionId: string;
  startTime: Date;
  endTime: Date;
  totalDuration: number;
  status: 'completed' | 'failed' | 'partial';
  parameters: Record<string, any>;
  steps: StepReport[];
  summary: {
    stepsCompleted: number;
    totalSteps: number;
    entitiesCreated: number;
    entitiesUpdated: number;
    filesCreated: string[];
    contentChanges: boolean;
  };
  recommendations: string[];
}

export class WorkflowReportAgent {
  private reportsDir: string;
  private currentReport: WorkflowReport | null = null;

  constructor(repositoryPath: string = '.') {
    this.reportsDir = path.join(repositoryPath, '.data', 'workflow-reports');
    this.ensureReportsDirectory();
  }

  private ensureReportsDirectory(): void {
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
      log('Created workflow reports directory', 'info', { path: this.reportsDir });
    }
  }

  /**
   * Start tracking a new workflow execution
   */
  startWorkflowReport(workflowName: string, executionId: string, parameters: Record<string, any>): void {
    this.currentReport = {
      workflowName,
      executionId,
      startTime: new Date(),
      endTime: new Date(),
      totalDuration: 0,
      status: 'partial',
      parameters,
      steps: [],
      summary: {
        stepsCompleted: 0,
        totalSteps: 0,
        entitiesCreated: 0,
        entitiesUpdated: 0,
        filesCreated: [],
        contentChanges: false
      },
      recommendations: []
    };

    log('Started workflow report', 'info', { workflowName, executionId });
  }

  /**
   * Record a step's execution details
   */
  recordStep(stepReport: StepReport): void {
    if (!this.currentReport) {
      log('No active workflow report - step not recorded', 'warning', { stepName: stepReport.stepName });
      return;
    }

    this.currentReport.steps.push(stepReport);

    if (stepReport.status === 'success') {
      this.currentReport.summary.stepsCompleted++;
    }

    log('Recorded step in workflow report', 'debug', {
      stepName: stepReport.stepName,
      status: stepReport.status,
      duration: stepReport.duration
    });
  }

  /**
   * Finalize and save the workflow report
   */
  finalizeReport(
    status: 'completed' | 'failed' | 'partial',
    summary: WorkflowReport['summary']
  ): string {
    if (!this.currentReport) {
      log('No active workflow report to finalize', 'warning');
      return '';
    }

    this.currentReport.endTime = new Date();
    this.currentReport.totalDuration = this.currentReport.endTime.getTime() - this.currentReport.startTime.getTime();
    this.currentReport.status = status;
    this.currentReport.summary = { ...this.currentReport.summary, ...summary };
    // Use provided totalSteps if available (for batch workflows), otherwise fall back to steps.length
    if (!this.currentReport.summary.totalSteps) {
      this.currentReport.summary.totalSteps = this.currentReport.steps.length;
    }

    // Generate recommendations based on analysis
    this.currentReport.recommendations = this.generateRecommendations();

    // Generate and save the markdown report
    const reportPath = this.saveReport();

    log('Finalized workflow report', 'info', {
      path: reportPath,
      status,
      duration: this.currentReport.totalDuration,
      stepsCompleted: this.currentReport.summary.stepsCompleted
    });

    // Clear current report
    const savedReport = this.currentReport;
    this.currentReport = null;

    return reportPath;
  }

  private generateRecommendations(): string[] {
    if (!this.currentReport) return [];

    const recommendations: string[] = [];
    const report = this.currentReport;

    // Check for empty results
    if (report.summary.entitiesCreated === 0 && report.summary.entitiesUpdated === 0) {
      recommendations.push('No entities were created or updated. Check if the analysis agents are returning meaningful data.');
    }

    // Check for failed steps
    const failedSteps = report.steps.filter(s => s.status === 'failed');
    if (failedSteps.length > 0) {
      recommendations.push(`${failedSteps.length} step(s) failed: ${failedSteps.map(s => s.stepName).join(', ')}. Review error details.`);
    }

    // Check for slow steps
    const slowSteps = report.steps.filter(s => s.duration > 60000);
    if (slowSteps.length > 0) {
      recommendations.push(`${slowSteps.length} step(s) took >60s: ${slowSteps.map(s => `${s.stepName} (${(s.duration/1000).toFixed(1)}s)`).join(', ')}`);
    }

    // Check for empty inputs
    const emptyInputSteps = report.steps.filter(s =>
      s.status === 'success' &&
      Object.keys(s.inputs).length === 0
    );
    if (emptyInputSteps.length > 0) {
      recommendations.push(`${emptyInputSteps.length} step(s) had empty inputs - may indicate upstream issues.`);
    }

    // Check for no content changes
    if (!report.summary.contentChanges) {
      recommendations.push('No content changes detected. Verify that analysis agents are finding new patterns/insights.');
    }

    return recommendations;
  }

  private saveReport(): string {
    if (!this.currentReport) return '';

    const timestamp = this.currentReport.startTime.toISOString().replace(/[:.]/g, '-');
    const filename = `${this.currentReport.workflowName}-${timestamp}.md`;
    const filepath = path.join(this.reportsDir, filename);

    const markdown = this.generateMarkdownReport();
    fs.writeFileSync(filepath, markdown, 'utf-8');

    return filepath;
  }

  private generateMarkdownReport(): string {
    if (!this.currentReport) return '';

    const report = this.currentReport;
    const lines: string[] = [];

    // Header
    lines.push(`# Workflow Execution Report`);
    lines.push('');
    lines.push(`**Workflow:** ${report.workflowName}`);
    lines.push(`**Execution ID:** ${report.executionId}`);
    lines.push(`**Status:** ${this.getStatusEmoji(report.status)} ${report.status.toUpperCase()}`);
    lines.push(`**Start Time:** ${report.startTime.toISOString()}`);
    lines.push(`**End Time:** ${report.endTime.toISOString()}`);
    lines.push(`**Duration:** ${(report.totalDuration / 1000).toFixed(2)}s`);
    lines.push('');

    // Parameters
    lines.push('## Parameters');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(report.parameters, null, 2));
    lines.push('```');
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Steps Completed | ${report.summary.stepsCompleted}/${report.summary.totalSteps} |`);
    lines.push(`| Entities Created | ${report.summary.entitiesCreated} |`);
    lines.push(`| Entities Updated | ${report.summary.entitiesUpdated} |`);
    lines.push(`| Files Created | ${report.summary.filesCreated.length} |`);
    lines.push(`| Content Changes | ${report.summary.contentChanges ? 'Yes' : 'No'} |`);
    lines.push('');

    if (report.summary.filesCreated.length > 0) {
      lines.push('### Files Created');
      lines.push('');
      report.summary.filesCreated.forEach(f => lines.push(`- ${f}`));
      lines.push('');
    }

    // Recommendations
    if (report.recommendations.length > 0) {
      lines.push('## Recommendations');
      lines.push('');
      report.recommendations.forEach((rec, i) => {
        lines.push(`${i + 1}. ${rec}`);
      });
      lines.push('');
    }

    // Step Details
    lines.push('## Step-by-Step Execution');
    lines.push('');

    report.steps.forEach((step, index) => {
      lines.push(`### ${index + 1}. ${step.stepName}`);
      lines.push('');
      lines.push(`**Agent:** ${step.agent}`);
      lines.push(`**Action:** ${step.action}`);
      lines.push(`**Status:** ${this.getStatusEmoji(step.status)} ${step.status}`);
      lines.push(`**Duration:** ${(step.duration / 1000).toFixed(2)}s`);
      lines.push('');

      // Inputs summary
      lines.push('#### Inputs');
      lines.push('');
      if (Object.keys(step.inputs).length === 0) {
        lines.push('*No inputs provided*');
      } else {
        lines.push('```json');
        lines.push(this.summarizeObject(step.inputs, 3));
        lines.push('```');
      }
      lines.push('');

      // Outputs summary
      lines.push('#### Outputs');
      lines.push('');
      if (Object.keys(step.outputs).length === 0) {
        lines.push('*No outputs produced*');
      } else {
        lines.push('```json');
        lines.push(this.summarizeObject(step.outputs, 3));
        lines.push('```');
      }
      lines.push('');

      // Decisions
      if (step.decisions.length > 0) {
        lines.push('#### Decisions Made');
        lines.push('');
        step.decisions.forEach(d => lines.push(`- ${d}`));
        lines.push('');
      }

      // Warnings
      if (step.warnings.length > 0) {
        lines.push('#### Warnings');
        lines.push('');
        step.warnings.forEach(w => lines.push(`- ${w}`));
        lines.push('');
      }

      // Errors
      if (step.errors.length > 0) {
        lines.push('#### Errors');
        lines.push('');
        step.errors.forEach(e => lines.push(`- ${e}`));
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    });

    // Footer
    lines.push('');
    lines.push(`*Report generated at ${new Date().toISOString()}*`);

    return lines.join('\n');
  }

  private getStatusEmoji(status: string): string {
    switch (status) {
      case 'completed':
      case 'success':
        return '';
      case 'failed':
        return '';
      case 'partial':
      case 'skipped':
        return '';
      default:
        return '';
    }
  }

  /**
   * Summarize a complex object for display, limiting depth and array lengths
   */
  private summarizeObject(obj: any, maxDepth: number, currentDepth: number = 0): string {
    if (currentDepth >= maxDepth) {
      if (Array.isArray(obj)) {
        return `[Array(${obj.length})]`;
      } else if (typeof obj === 'object' && obj !== null) {
        return `{...${Object.keys(obj).length} keys}`;
      }
      return JSON.stringify(obj);
    }

    if (obj === null || obj === undefined) {
      return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) return '[]';
      if (obj.length > 5) {
        const preview = obj.slice(0, 3).map(item =>
          this.summarizeObject(item, maxDepth, currentDepth + 1)
        );
        // Return valid JSON string representation
        return JSON.stringify([...preview.map(p => { try { return JSON.parse(p); } catch { return p; } }), `... +${obj.length - 3} more`]);
      }
      return JSON.stringify(obj.map(item => {
        const summarized = this.summarizeObject(item, maxDepth, currentDepth + 1);
        try {
          return JSON.parse(summarized);
        } catch {
          return summarized;
        }
      }), null, 2);
    }

    if (typeof obj === 'object') {
      const keys = Object.keys(obj);
      if (keys.length === 0) return '{}';

      const summarized: Record<string, any> = {};
      const displayKeys = keys.slice(0, 10);

      for (const key of displayKeys) {
        const value = obj[key];
        if (typeof value === 'string' && value.length > 200) {
          summarized[key] = value.substring(0, 200) + '... [truncated]';
        } else {
          const valueSummary = this.summarizeObject(value, maxDepth, currentDepth + 1);
          try {
            summarized[key] = JSON.parse(valueSummary);
          } catch {
            summarized[key] = valueSummary;
          }
        }
      }

      if (keys.length > 10) {
        summarized['...'] = `+${keys.length - 10} more keys`;
      }

      return JSON.stringify(summarized, null, 2);
    }

    return JSON.stringify(obj);
  }

  /**
   * Get the path to the latest report for a workflow
   */
  getLatestReportPath(workflowName: string): string | null {
    const files = fs.readdirSync(this.reportsDir)
      .filter(f => f.startsWith(workflowName) && f.endsWith('.md'))
      .sort()
      .reverse();

    if (files.length === 0) return null;
    return path.join(this.reportsDir, files[0]);
  }

  /**
   * List all available reports
   */
  listReports(): string[] {
    return fs.readdirSync(this.reportsDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();
  }
}
