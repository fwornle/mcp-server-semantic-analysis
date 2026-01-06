/**
 * End-to-End Test for Ontology Integration
 *
 * Tests that the PersistenceAgent correctly:
 * 1. Initializes the ontology system
 * 2. Classifies entities using the ontology
 * 3. Stores entities with ontology metadata to GraphDB
 * 4. Retrieves entities with classification info
 */

import { PersistenceAgent } from './src/agents/persistence-agent.js';
import { GraphDatabaseAdapter } from './src/storage/graph-database-adapter.js';
import * as fs from 'fs';
import * as path from 'path';

// Test configuration
const TEST_REPO_PATH = '/Users/q284340/Agentic/coding';
const TEST_TIMEOUT = 30000; // 30 seconds

// ANSI color codes for output
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

async function testOntologyIntegration() {
  section('Ontology Integration Test Suite');

  let testsPassed = 0;
  let testsFailed = 0;
  const startTime = Date.now();

  try {
    // Test 1: Initialize PersistenceAgent
    section('Test 1: Initialize PersistenceAgent with Ontology');

    const graphDB = new GraphDatabaseAdapter();
    await graphDB.initialize();
    log('GraphDB adapter initialized', 'success');

    const persistenceAgent = new PersistenceAgent(TEST_REPO_PATH, graphDB, {
      ontologyTeam: 'coding',
      ontologyMinConfidence: 0.7
    });
    log('PersistenceAgent created', 'success');

    await persistenceAgent.initializeOntology();
    log('Ontology system initialized', 'success');
    testsPassed++;

    // Test 2: Create test entities with different types
    section('Test 2: Create and Classify Test Entities');

    const testEntities = [
      {
        name: 'TestLSLSession',
        observations: [
          'Live session log capturing development session',
          'Records tool interactions and conversation exchanges',
          'Timestamp: 2025-11-15',
          'Generated from Claude Code transcript'
        ],
        expectedType: 'LSLSession'
      },
      {
        name: 'TestMCPServer',
        observations: [
          'Model Context Protocol server implementation',
          'Provides semantic analysis tools',
          'Exports MCP protocol resources',
          'Integrates with Claude Code'
        ],
        expectedType: 'MCPAgent'
      },
      {
        name: 'TestGraphDatabase',
        observations: [
          'Graphology-based knowledge graph storage',
          'LevelDB persistent backend',
          'Team-isolated entity storage with node ID pattern',
          'Auto-export to JSON for git tracking'
        ],
        expectedType: 'GraphDatabase'
      },
      {
        name: 'GenericPattern',
        observations: [
          'Some generic transferable pattern',
          'Not matching any specific ontology type'
        ],
        expectedType: 'TransferablePattern' // Should fall back
      }
    ];

    const classificationResults: any[] = [];

    for (const testEntity of testEntities) {
      log(`Testing entity: ${testEntity.name}`, 'info');

      const entity = {
        id: `test-${Date.now()}-${Math.random()}`,
        name: testEntity.name,
        entityType: 'TransferablePattern', // Will be overridden by classification
        significance: 7,
        observations: testEntity.observations,
        relationships: [],
        metadata: {
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
          source: 'ontology-integration-test',
          team: 'coding',
          isTestData: true  // Mark as test data for cleanup
        }
      };

      // Store entity (this will trigger classification)
      const result = await (persistenceAgent as any).storeEntityToGraph(entity);

      if (result) {
        log(`  Entity stored with nodeId: ${result}`, 'success');
        classificationResults.push({
          name: testEntity.name,
          nodeId: result,
          expected: testEntity.expectedType
        });
        testsPassed++;
      } else {
        log(`  Failed to store entity: ${testEntity.name}`, 'error');
        testsFailed++;
      }
    }

    // Test 3: Verify entities in GraphDB
    section('Test 3: Verify Entities in GraphDB');

    for (const result of classificationResults) {
      try {
        // Query the entity from GraphDB using namePattern
        const entities = await graphDB.queryEntities({ namePattern: result.name });

        if (entities && entities.length > 0) {
          const storedEntity = entities[0];
          log(`  Retrieved entity: ${result.name}`, 'success');
          log(`    Entity Type: ${storedEntity.entityType}`, 'info');

          if (storedEntity.metadata?.classificationMethod) {
            log(`    Classification Method: ${storedEntity.metadata.classificationMethod}`, 'info');
            log(`    Classification Confidence: ${storedEntity.metadata.classificationConfidence}`, 'info');
          }

          if (storedEntity.metadata?.ontology) {
            log(`    Ontology Metadata: ${JSON.stringify(storedEntity.metadata.ontology).substring(0, 100)}...`, 'info');
          }

          // Verify entity type matches expected (or is reasonable fallback)
          if (storedEntity.entityType === result.expected) {
            log(`    ✓ Entity type matches expected: ${result.expected}`, 'success');
            testsPassed++;
          } else if (storedEntity.entityType === 'TransferablePattern' &&
                     storedEntity.metadata?.classificationConfidence < 0.7) {
            log(`    ✓ Correctly fell back to TransferablePattern (low confidence)`, 'success');
            testsPassed++;
          } else {
            log(`    ⚠ Entity type mismatch: expected ${result.expected}, got ${storedEntity.entityType}`, 'warning');
          }
        } else {
          log(`  Failed to retrieve entity: ${result.name}`, 'error');
          testsFailed++;
        }
      } catch (error) {
        log(`  Error verifying entity ${result.name}: ${error}`, 'error');
        testsFailed++;
      }
    }

    // Test 4: Check ontology metadata structure
    section('Test 4: Validate Ontology Metadata Structure');

    const sampleEntities = await graphDB.queryEntities({ namePattern: 'TestLSLSession' });
    const sampleEntity = sampleEntities && sampleEntities.length > 0 ? sampleEntities[0] : null;
    if (sampleEntity && sampleEntity.metadata) {
      const requiredFields = ['classificationMethod', 'classificationConfidence'];
      let metadataValid = true;

      for (const field of requiredFields) {
        if (field in sampleEntity.metadata) {
          log(`  ✓ Has ${field}: ${sampleEntity.metadata[field]}`, 'success');
        } else {
          log(`  ✗ Missing ${field}`, 'error');
          metadataValid = false;
        }
      }

      if (metadataValid) {
        testsPassed++;
      } else {
        testsFailed++;
      }
    } else {
      log('  Could not retrieve sample entity for metadata validation', 'error');
      testsFailed++;
    }

    // Cleanup: Delete test entities
    section('Cleanup: Deleting Test Entities');

    const testEntityNames = ['TestLSLSession', 'TestMCPServer', 'TestGraphDatabase', 'GenericPattern'];
    for (const entityName of testEntityNames) {
      try {
        const entities = await graphDB.queryEntities({ namePattern: entityName });
        if (entities && entities.length > 0) {
          // Delete each matching entity
          for (const entity of entities) {
            if (entity.metadata?.isTestData) {
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
    log('GraphDB closed', 'success');

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
      console.log(`\n${colors.green}${colors.bright}✓ ALL TESTS PASSED!${colors.reset}\n`);
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
testOntologyIntegration()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
