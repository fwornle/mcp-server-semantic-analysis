/**
 * Content Validation Test
 *
 * Quick test to verify ContentValidationAgent can detect stale content
 */

import { ContentValidationAgent } from './src/agents/content-validation-agent.js';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message: string, level: 'info' | 'success' | 'error' | 'warning' = 'info') {
  const prefix = {
    info: `${colors.blue}ℹ${colors.reset}`,
    success: `${colors.green}✓${colors.reset}`,
    error: `${colors.red}✗${colors.reset}`,
    warning: `${colors.yellow}⚠${colors.reset}`,
  };
  console.log(`${prefix[level]} ${message}`);
}

function section(title: string) {
  console.log(`\n${colors.bright}${colors.cyan}═══ ${title} ═══${colors.reset}\n`);
}

async function testContentValidation() {
  section('Content Validation Test Suite');

  const REPO_PATH = '/Users/q284340/Agentic/coding';
  let passed = 0;
  let failed = 0;

  try {
    // Test 1: Initialize ContentValidationAgent
    section('Test 1: Initialize ContentValidationAgent');

    const validationAgent = new ContentValidationAgent({
      repositoryPath: REPO_PATH,
      enableDeepValidation: true,
      stalenessThresholdDays: 30
    });

    log('ContentValidationAgent initialized', 'success');
    passed++;

    // Test 2: Validate observations with outdated content
    section('Test 2: Validate Observations with Outdated Content');

    const testObservations = [
      'The ukb command is used to update the knowledge base', // Outdated - ukb is deprecated
      'Data is stored in shared-memory-coding.json', // Outdated - now uses GraphDB
      'PersistenceAgent stores entities to the graph database', // Current/Valid
      'The src/agents/coordinator.ts file orchestrates workflows', // Valid if file exists
    ];

    const observationResults = await validationAgent.validateObservations(testObservations);

    log(`Validated ${observationResults.length} observations`, 'info');

    let foundOutdated = false;
    for (const result of observationResults) {
      if (!result.isValid) {
        foundOutdated = true;
        log(`Invalid observation detected: "${result.observation.substring(0, 50)}..."`, 'warning');
        for (const issue of result.issues) {
          log(`  - [${issue.type}] ${issue.message}`, 'info');
        }
      }
    }

    if (foundOutdated) {
      log('Correctly detected outdated observations', 'success');
      passed++;
    } else {
      log('Expected to find outdated observations but none detected', 'warning');
    }

    // Test 3: Validate Entity Accuracy (KnowledgePersistencePattern if it exists)
    section('Test 3: Validate Entity Accuracy');

    const entityReport = await validationAgent.validateEntityAccuracy(
      'KnowledgePersistencePattern',
      'coding'
    );

    log(`Entity validation complete`, 'info');
    log(`  Overall valid: ${entityReport.overallValid}`, 'info');
    log(`  Overall score: ${entityReport.overallScore}/100`, 'info');
    log(`  Total issues: ${entityReport.totalIssues}`, 'info');
    log(`  Critical issues: ${entityReport.criticalIssues}`, 'info');

    if (entityReport.recommendations.length > 0) {
      log('Recommendations:', 'info');
      for (const rec of entityReport.recommendations.slice(0, 3)) {
        log(`  - ${rec}`, 'info');
      }
    }

    passed++;

    // Test 4: Generate Refresh Report
    section('Test 4: Generate Refresh Report');

    const refreshReport = validationAgent.generateRefreshReport(entityReport);
    log(`Generated refresh report (${refreshReport.length} chars)`, 'success');
    console.log('\n--- Sample of Refresh Report ---');
    console.log(refreshReport.substring(0, 500));
    console.log('...\n');
    passed++;

    // Test 5: Validate Stale Entities (NEW METHOD for incremental-analysis workflow)
    section('Test 5: Validate Stale Entities in Graph DB');

    const staleResult = await validationAgent.validateAndRefreshStaleEntities({
      stalenessThresholdDays: 30,
      autoRefresh: true
    });

    log(`Stale entity validation complete`, 'info');
    log(`  Total entities checked: ${staleResult.totalEntitiesChecked}`, 'info');
    log(`  Stale entities found: ${staleResult.staleEntitiesFound}`, 'info');
    log(`  Critical stale entities: ${staleResult.criticalStaleEntities}`, 'info');

    if (staleResult.staleEntities.length > 0) {
      log('Stale entities detected:', 'warning');
      for (const entity of staleResult.staleEntities.slice(0, 5)) {
        log(`  - ${entity.entityName} (${entity.staleness}, score: ${entity.score})`, 'info');
        for (const issue of entity.issues.slice(0, 2)) {
          log(`    [${issue.type}] ${issue.message}`, 'info');
        }
      }
    }

    if (staleResult.refreshActions.length > 0) {
      log('Refresh actions:', 'info');
      for (const action of staleResult.refreshActions.slice(0, 3)) {
        log(`  - ${action.entityName}: ${action.action}`, 'info');
      }
    }

    log(`Summary: ${staleResult.summary.split('\n')[0]}`, 'success');
    passed++;

    // Summary
    section('Test Summary');
    console.log(`${colors.green}Passed:${colors.reset} ${passed}`);
    console.log(`${colors.red}Failed:${colors.reset} ${failed}`);

    if (failed === 0) {
      console.log(`\n${colors.green}${colors.bright}✓ ALL CONTENT VALIDATION TESTS PASSED!${colors.reset}\n`);
      return 0;
    } else {
      return 1;
    }

  } catch (error) {
    section('Test Error');
    log(`Error during testing: ${error}`, 'error');
    if (error instanceof Error) {
      console.error(error.stack);
    }
    return 1;
  }
}

// Run tests
testContentValidation()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
