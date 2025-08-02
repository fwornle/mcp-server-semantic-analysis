#!/usr/bin/env node

/**
 * Standalone QA Agent Test
 * Tests the QualityAssuranceAgent timing thresholds and validation logic
 */

import { QualityAssuranceAgent } from './dist/agents/quality-assurance-agent.js';
import { log } from './dist/logging.js';

async function testQAAgent() {
  console.log('🔍 Starting standalone QA Agent test...\n');
  
  const agent = new QualityAssuranceAgent('.');
  
  // Test 1: Timing validation with different scenarios
  console.log('⏱️  Test 1: Timing validation');  
  console.log('============================');
  
  const timingScenarios = [
    {
      name: 'Git History - Too Fast',
      stepName: 'analyze_git_history',
      startTime: new Date('2025-08-01T12:00:00Z'),
      endTime: new Date('2025-08-01T12:00:00.030Z'), // 30ms
      timeout: 120,
      expectedWarnings: ['completed suspiciously fast']
    },
    {
      name: 'Git History - Normal',
      stepName: 'analyze_git_history',
      startTime: new Date('2025-08-01T12:00:00Z'),
      endTime: new Date('2025-08-01T12:00:15Z'), // 15 seconds
      timeout: 120,
      expectedWarnings: []
    },
    {
      name: 'Semantic Analysis - Too Fast (Current Issue)',
      stepName: 'semantic_analysis',
      startTime: new Date('2025-08-01T12:00:00Z'),
      endTime: new Date('2025-08-01T12:00:00.500Z'), // 500ms
      timeout: 180, 
      expectedErrors: ['LLM step semantic_analysis completed too quickly']
    },
    {
      name: 'Semantic Analysis - Reasonable',
      stepName: 'semantic_analysis',
      startTime: new Date('2025-08-01T12:00:00Z'),
      endTime: new Date('2025-08-01T12:00:12Z'), // 12 seconds
      timeout: 180,
      expectedWarnings: []
    },
    {
      name: 'Semantic Analysis - Actual Performance',
      stepName: 'semantic_analysis', 
      startTime: new Date('2025-08-01T12:00:00Z'),
      endTime: new Date('2025-08-01T12:00:07Z'), // 7 seconds (actual measured)
      timeout: 180,
      expectedWarnings: [] // Should pass now
    }
  ];
  
  for (const scenario of timingScenarios) {
    console.log(`\n🧪 Testing: ${scenario.name}`);
    
    try {
      const result = await agent.performComprehensiveQA(
        scenario.stepName,
        { test: 'data' }, // Mock result
        undefined,
        {
          startTime: scenario.startTime,
          endTime: scenario.endTime,
          timeout: scenario.timeout
        }
      );
      
      console.log(`  📊 QA Result:`);
      console.log(`    Passed: ${result.passed}`);
      console.log(`    Errors: ${result.errors.length}`);
      console.log(`    Warnings: ${result.warnings.length}`);
      console.log(`    Score: ${result.score}/100`);
      
      if (result.errors.length > 0) {
        console.log(`    🔴 Errors:`);
        result.errors.forEach(error => console.log(`      - ${error}`));
      }
      
      if (result.warnings.length > 0) {
        console.log(`    🟡 Warnings:`);
        result.warnings.forEach(warning => console.log(`      - ${warning}`));
      }
      
      // Check if expectations match
      const hasExpectedErrors = scenario.expectedErrors?.some(expected => 
        result.errors.some(error => error.includes(expected))
      ) || (scenario.expectedErrors?.length === 0 || !scenario.expectedErrors);
      
      const hasExpectedWarnings = scenario.expectedWarnings?.some(expected =>
        result.warnings.some(warning => warning.includes(expected))
      ) || (scenario.expectedWarnings?.length === 0 || !scenario.expectedWarnings);
      
      console.log(`    ✅ Expected errors: ${hasExpectedErrors}`);
      console.log(`    ✅ Expected warnings: ${hasExpectedWarnings}`);
      
    } catch (error) {
      console.error(`  ❌ Failed: ${error.message}`);
    }
  }
  
  // Test 2: Step-specific validation
  console.log('\n\n🔧 Test 2: Step-specific validation');
  console.log('====================================');
  
  const stepTestCases = [
    {
      stepName: 'analyze_git_history',
      result: {
        commits: [
          { hash: '123', message: 'test', date: '2025-08-01', author: 'test' }
        ],
        summary: 'Test git analysis'
      },
      expectPass: true
    },
    {
      stepName: 'analyze_git_history',
      result: null,
      expectPass: false
    },
    {
      stepName: 'semantic_analysis',
      result: {
        insights: ['Test insight'],
        patterns: [{ name: 'TestPattern' }]
      },
      expectPass: true
    },
    {
      stepName: 'semantic_analysis',
      result: {},
      expectPass: false
    }
  ];
  
  for (const testCase of stepTestCases) {
    console.log(`\n🧪 Testing step validation: ${testCase.stepName}`);
    
    try {
      const result = await agent.performComprehensiveQA(
        testCase.stepName,
        testCase.result,
        undefined,
        {
          startTime: new Date('2025-08-01T12:00:00Z'),
          endTime: new Date('2025-08-01T12:00:30Z'), // Reasonable timing
          timeout: 120
        }
      );
      
      console.log(`  📊 Validation Result:`);
      console.log(`    Passed: ${result.passed}`);
      console.log(`    Score: ${result.score}/100`);
      
      if (testCase.expectPass && !result.passed) {
        console.log(`  ❌ Expected to pass but failed`);
      } else if (!testCase.expectPass && result.passed) {
        console.log(`  ❌ Expected to fail but passed`);
      } else {
        console.log(`  ✅ Result matches expectation`);
      }
      
    } catch (error) {
      console.error(`  ❌ Validation failed: ${error.message}`);
    }
  }
  
  // Test 3: Threshold calibration analysis
  console.log('\n\n📏 Test 3: Threshold calibration analysis');
  console.log('==========================================');
  
  // Actual measurements from our tests
  const actualPerformance = {
    'analyze_git_history': { avg: 22, range: [20, 81] },
    'semantic_analysis': { avg: 6000, range: [4711, 8093] },
    'generate_insights': { avg: 5000, range: [4000, 7000] }, // Estimated
    'quality_assurance': { avg: 100, range: [50, 200] }     // Estimated
  };
  
  // Current QA expectations (from quality-assurance-agent.ts)
  const currentExpectations = {
    'analyze_git_history': { min: 5000, ideal: 30000, max: 120000 },
    'semantic_analysis': { min: 10000, ideal: 60000, max: 180000 },
    'generate_insights': { min: 15000, ideal: 90000, max: 300000 },
    'quality_assurance': { min: 2000, ideal: 10000, max: 60000 }
  };
  
  console.log('📊 Performance vs Expectations Analysis:');
  
  for (const [stepName, actual] of Object.entries(actualPerformance)) {
    const expected = currentExpectations[stepName];
    
    console.log(`\n🔍 ${stepName}:`);
    console.log(`  📈 Actual performance: ${actual.avg}ms (${actual.range[0]}-${actual.range[1]}ms)`);
    console.log(`  🎯 QA expectations: ${expected.min}-${expected.max}ms`);
    
    const tooLowMin = actual.avg < expected.min;
    const tooHighMax = actual.avg > expected.max;
    const needsAdjustment = tooLowMin || tooHighMax;
    
    if (tooLowMin) {
      console.log(`  ⚠️  ISSUE: Actual avg (${actual.avg}ms) < QA min (${expected.min}ms)`);
      const suggestedMin = Math.floor(actual.range[0] * 0.5); // 50% of minimum observed
      console.log(`  💡 Suggested min: ${suggestedMin}ms`);
    }
    
    if (tooHighMax) {
      console.log(`  ⚠️  ISSUE: Actual avg (${actual.avg}ms) > QA max (${expected.max}ms)`);
      const suggestedMax = Math.ceil(actual.range[1] * 2); // 200% of maximum observed
      console.log(`  💡 Suggested max: ${suggestedMax}ms`);
    }
    
    if (!needsAdjustment) {
      console.log(`  ✅ QA expectations are appropriate`);
    }
  }
  
  // Test 4: Workflow QA test
  console.log('\n\n🔄 Test 4: Full workflow QA');
  console.log('============================');
  
  const mockWorkflowResults = {
    git_history: {
      commits: [{ hash: '123', message: 'test' }],
      summary: 'Test'
    },
    vibe_history: {
      sessions: [{ content: 'test session' }]
    },
    semantic_analysis: {
      insights: ['Test insight'],
      patterns: [{ name: 'TestPattern' }]
    },
    web_search: {
      results: ['search result']
    },
    insights: {
      generated: ['Generated insight']
    },
    observations: {
      observations: ['Test observation']
    }
  };
  
  try {
    console.log('🔄 Running full workflow QA...');
    const result = await agent.performWorkflowQA({
      all_results: mockWorkflowResults
    });
    
    console.log(`📊 Workflow QA Summary:`);
    console.log(`  Overall Status: ${result.overallStatus}`);
    console.log(`  Total Steps: ${result.stepReports.length}`);
    
    let passedSteps = 0;
    let failedSteps = 0;
    
    result.stepReports.forEach(stepReport => {
      console.log(`\n  📋 ${stepReport.stepName}:`);
      console.log(`    Status: ${stepReport.passed ? '✅ PASS' : '❌ FAIL'}`);
      console.log(`    Score: ${stepReport.score}/100`);
      console.log(`    Errors: ${stepReport.errors.length}`);
      console.log(`    Warnings: ${stepReport.warnings.length}`);
      
      if (stepReport.passed) passedSteps++;
      else failedSteps++;
    });
    
    console.log(`\n📊 Final Stats:`);
    console.log(`  ✅ Passed: ${passedSteps}`);
    console.log(`  ❌ Failed: ${failedSteps}`);
    console.log(`  📈 Success Rate: ${(passedSteps / result.stepReports.length * 100).toFixed(1)}%`);
    
  } catch (error) {
    console.error(`❌ Workflow QA failed: ${error.message}`);
  }
  
  console.log('\n🏁 QA Agent standalone test completed!');
}

// Run the test
testQAAgent().catch(console.error);