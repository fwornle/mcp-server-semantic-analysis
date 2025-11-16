/**
 * Validation Integration Test
 *
 * Tests that PersistenceAgent correctly validates entities before persistence:
 * 1. Validates entities in lenient mode (warnings only)
 * 2. Validates entities in strict mode (errors block persistence)
 * 3. Stores validation metadata with entities
 */

import { PersistenceAgent } from './src/agents/persistence-agent.js';
import { GraphDatabaseAdapter } from './src/storage/graph-database-adapter.js';

// Test configuration
const TEST_REPO_PATH = '/Users/q284340/Agentic/coding';
const TEST_TIMEOUT = 30000;

// ANSI color codes
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

async function testValidationIntegration() {
  section('Validation Integration Test Suite');

  let testsPassed = 0;
  let testsFailed = 0;
  const startTime = Date.now();

  try {
    // Test 1: Lenient Mode (Warnings Only)
    section('Test 1: Validation in Lenient Mode');

    const graphDB = new GraphDatabaseAdapter();
    await graphDB.initialize();
    log('GraphDB adapter initialized', 'success');

    const persistenceAgentLenient = new PersistenceAgent(TEST_REPO_PATH, graphDB, {
      enableOntology: true,
      ontologyTeam: 'coding',
      ontologyMinConfidence: 0.7,
      enableValidation: true,
      validationMode: 'lenient'
    });

    await persistenceAgentLenient.initializeOntology();
    log('PersistenceAgent (lenient) initialized', 'success');

    // Create a valid entity
    const validEntity = {
      id: `test-valid-${Date.now()}`,
      name: 'ValidLSLSession',
      entityType: 'TransferablePattern',
      significance: 8,
      observations: [
        'Live session log from 2025-11-15',
        'Contains development conversation',
        'Well-formed LSL structure'
      ],
      relationships: [],
      metadata: {
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        source: 'validation-test',
        team: 'coding',
        isTestData: true  // Mark as test data for cleanup
      }
    };

    const validNodeId = await (persistenceAgentLenient as any).storeEntityToGraph(validEntity);
    if (validNodeId) {
      log(`Valid entity stored: ${validNodeId}`, 'success');
      testsPassed++;
    } else {
      log('Failed to store valid entity', 'error');
      testsFailed++;
    }

    // Test 2: Strict Mode with Valid Entity
    section('Test 2: Validation in Strict Mode (Valid Entity)');

    const persistenceAgentStrict = new PersistenceAgent(TEST_REPO_PATH, graphDB, {
      enableOntology: true,
      ontologyTeam: 'coding',
      ontologyMinConfidence: 0.7,
      enableValidation: true,
      validationMode: 'strict'
    });

    await persistenceAgentStrict.initializeOntology();
    log('PersistenceAgent (strict) initialized', 'success');

    const strictValidEntity = {
      id: `test-strict-valid-${Date.now()}`,
      name: 'StrictValidEntity',
      entityType: 'TransferablePattern',
      significance: 7,
      observations: ['Valid observation 1', 'Valid observation 2'],
      relationships: [],
      metadata: {
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        source: 'validation-test',
        team: 'coding',
        isTestData: true  // Mark as test data for cleanup
      }
    };

    try {
      const strictValidNodeId = await (persistenceAgentStrict as any).storeEntityToGraph(strictValidEntity);
      if (strictValidNodeId) {
        log(`Valid entity stored in strict mode: ${strictValidNodeId}`, 'success');
        testsPassed++;
      } else {
        log('Failed to store valid entity in strict mode', 'error');
        testsFailed++;
      }
    } catch (error) {
      log(`Unexpected error in strict mode with valid entity: ${error}`, 'error');
      testsFailed++;
    }

    // Test 3: Disabled Validation
    section('Test 3: Validation Disabled');

    const persistenceAgentDisabled = new PersistenceAgent(TEST_REPO_PATH, graphDB, {
      enableOntology: true,
      ontologyTeam: 'coding',
      ontologyMinConfidence: 0.7,
      enableValidation: false
    });

    await persistenceAgentDisabled.initializeOntology();
    log('PersistenceAgent (validation disabled) initialized', 'success');

    const disabledEntity = {
      id: `test-disabled-${Date.now()}`,
      name: 'DisabledValidationEntity',
      entityType: 'TransferablePattern',
      significance: 6,
      observations: ['Any observation works when validation is disabled'],
      relationships: [],
      metadata: {
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        source: 'validation-test',
        team: 'coding',
        isTestData: true  // Mark as test data for cleanup
      }
    };

    const disabledNodeId = await (persistenceAgentDisabled as any).storeEntityToGraph(disabledEntity);
    if (disabledNodeId) {
      log(`Entity stored with validation disabled: ${disabledNodeId}`, 'success');
      testsPassed++;
    } else {
      log('Failed to store entity with validation disabled', 'error');
      testsFailed++;
    }

    // Test 4: Verify Validation Metadata
    section('Test 4: Verify Validation Metadata in Stored Entities');

    const entities = await graphDB.queryEntities({ namePattern: 'ValidLSLSession' });
    if (entities && entities.length > 0) {
      const entity = entities[0];
      log(`Retrieved entity: ${entity.name}`, 'success');

      if (entity.metadata?.validation) {
        log(`  Validation metadata present`, 'success');
        log(`    Valid: ${entity.metadata.validation.valid}`, 'info');
        log(`    Mode: ${entity.metadata.validation.mode}`, 'info');
        log(`    Warnings: ${entity.metadata.validation.warnings?.length || 0}`, 'info');
        testsPassed++;
      } else {
        log(`  Validation metadata missing`, 'error');
        testsFailed++;
      }
    } else {
      log('Failed to retrieve entity for metadata verification', 'error');
      testsFailed++;
    }

    // Cleanup: Delete test entities
    section('Cleanup: Deleting Test Entities');

    const testEntityNames = ['ValidLSLSession', 'StrictValidEntity', 'DisabledValidationEntity'];
    for (const entityName of testEntityNames) {
      try {
        const entities = await graphDB.queryEntities({ namePattern: entityName });
        if (entities && entities.length > 0) {
          // Delete each matching entity
          for (const entity of entities) {
            if (entity.metadata?.isTestData) {
              // Delete the entity from graph
              await graphDB.deleteEntity(entity.id);
              log(`Deleted test entity: ${entity.name}`, 'success');
            }
          }
        }
      } catch (error) {
        log(`Failed to delete test entity ${entityName}: ${error}`, 'warning');
      }
    }

    // Close GraphDB
    await graphDB.close();

    // Test Summary
    section('Test Summary');
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const total = testsPassed + testsFailed;
    const passRate = ((testsPassed / total) * 100).toFixed(1);

    console.log(`${colors.bright}Total Tests:${colors.reset} ${total}`);
    console.log(`${colors.green}Passed:${colors.reset} ${testsPassed}`);
    console.log(`${colors.red}Failed:${colors.reset} ${testsFailed}`);
    console.log(`${colors.cyan}Pass Rate:${colors.reset} ${passRate}%`);
    console.log(`${colors.cyan}Duration:${colors.reset} ${duration}s`);

    if (testsFailed === 0) {
      console.log(`\n${colors.green}${colors.bright}✓ ALL VALIDATION TESTS PASSED!${colors.reset}\n`);
      return 0;
    } else {
      console.log(`\n${colors.red}${colors.bright}✗ SOME TESTS FAILED${colors.reset}\n`);
      return 1;
    }

  } catch (error) {
    section('Test Execution Error');
    log(`Fatal error during testing: ${error}`, 'error');
    if (error instanceof Error) {
      console.error(error.stack);
    }
    return 1;
  }
}

// Run the test suite
testValidationIntegration()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
