#!/usr/bin/env node

/**
 * Comprehensive E2E Test with Enhanced Monitoring
 * Tests the complete workflow with detailed logging and issue identification
 */

import { CoordinatorAgent } from './dist/agents/coordinator.js';
import { log } from './dist/logging.js';
import * as fs from 'fs';
import * as path from 'path';

async function runComprehensiveE2ETest() {
  console.log('🚀 Starting Comprehensive E2E Test with Enhanced Monitoring\n');
  console.log('=' .repeat(60));
  
  const coordinator = new CoordinatorAgent();
  
  // Test parameters
  const testWorkflow = 'complete-analysis';
  const testParams = {
    repository_path: '.',
    checkpoint_enabled: false,
    depth: 5,  // Small for testing
    days_back: 7
  };
  
  console.log('📋 Test Configuration:');
  console.log(`  Workflow: ${testWorkflow}`);
  console.log(`  Repository: ${testParams.repository_path}`);
  console.log(`  Depth: ${testParams.depth} commits`);
  console.log(`  Days: ${testParams.days_back} days back`);
  console.log('=' .repeat(60));
  
  try {
    console.log('\n🔄 Starting workflow execution...\n');
    
    // Monkey-patch the coordinator to add detailed logging
    const originalExecuteStep = coordinator.executeStepWithTimeout;
    coordinator.executeStepWithTimeout = async function(execution, step, parameters) {
      console.log(`\n📍 STEP: ${step.name}`);
      console.log(`  Agent: ${step.agent}`);
      console.log(`  Action: ${step.action}`);
      console.log(`  Timeout: ${step.timeout}s`);
      console.log(`  Dependencies: ${step.dependencies?.join(', ') || 'none'}`);
      
      const stepStart = Date.now();
      
      try {
        const result = await originalExecuteStep.call(this, execution, step, parameters);
        const duration = Date.now() - stepStart;
        
        console.log(`  ✅ Completed in ${duration}ms`);
        
        // Analyze result
        if (result) {
          const resultKeys = Object.keys(result);
          console.log(`  📊 Result keys: ${resultKeys.join(', ')}`);
          
          // Check for specific issues
          if (step.name === 'analyze_git_history') {
            console.log(`    - Commits: ${result.commits?.length || 0}`);
            console.log(`    - Has metadata: ${!!result.metadata}`);
            console.log(`    - Has stats: ${!!(result.total_changes || result.files_changed)}`);
          } else if (step.name === 'semantic_analysis') {
            console.log(`    - Has insights: ${!!result.insights}`);
            console.log(`    - Has patterns: ${!!result.patterns}`);
            console.log(`    - Confidence: ${result.confidence || 'N/A'}`);
          } else if (step.name === 'generate_insights') {
            console.log(`    - Generated insights: ${Array.isArray(result.insights) ? result.insights.length : 0}`);
            console.log(`    - Has meaningful content: ${result.insights?.[0]?.length > 50}`);
          }
        }
        
        return result;
      } catch (error) {
        const duration = Date.now() - stepStart;
        console.log(`  ❌ Failed after ${duration}ms`);
        console.log(`  🔴 Error: ${error.message}`);
        
        // Special handling for rate limits
        if (error.message?.includes('rate_limit')) {
          console.log(`  ⚠️  RATE LIMIT DETECTED - This explains the fast completion times!`);
        }
        
        throw error;
      }
    };
    
    // Execute workflow
    const startTime = Date.now();
    const execution = await coordinator.executeWorkflow(testWorkflow, testParams);
    const totalDuration = Date.now() - startTime;
    
    console.log('\n' + '=' .repeat(60));
    console.log('📊 WORKFLOW EXECUTION SUMMARY');
    console.log('=' .repeat(60));
    
    console.log(`\n🏁 Status: ${execution.status}`);
    console.log(`⏱️  Total Duration: ${totalDuration}ms`);
    console.log(`📈 Steps Completed: ${execution.currentStep}/${execution.totalSteps}`);
    
    // Analyze QA results
    if (execution.results.quality_assurance) {
      console.log('\n🔍 QUALITY ASSURANCE RESULTS:');
      const qaResult = execution.results.quality_assurance;
      
      if (qaResult.stepReports) {
        let passedSteps = 0;
        let failedSteps = 0;
        
        qaResult.stepReports.forEach(report => {
          console.log(`\n  📋 ${report.stepName}:`);
          console.log(`    Status: ${report.passed ? '✅ PASS' : '❌ FAIL'}`);
          console.log(`    Score: ${report.score}/100`);
          
          if (report.errors.length > 0) {
            console.log(`    🔴 Errors (${report.errors.length}):`);
            report.errors.slice(0, 3).forEach(err => console.log(`      - ${err}`));
          }
          
          if (report.warnings.length > 0) {
            console.log(`    🟡 Warnings (${report.warnings.length}):`);
            report.warnings.slice(0, 3).forEach(warn => console.log(`      - ${warn}`));
          }
          
          if (report.passed) passedSteps++;
          else failedSteps++;
        });
        
        console.log(`\n  📊 Summary: ${passedSteps} passed, ${failedSteps} failed`);
      }
    }
    
    // Check for specific issues
    console.log('\n🔍 ISSUE ANALYSIS:');
    
    // Issue 1: PlantUML filenames
    const generatedFiles = fs.readdirSync('knowledge-management/insights/puml')
      .filter(f => f.endsWith('.puml'))
      .sort((a, b) => fs.statSync(path.join('knowledge-management/insights/puml', b)).mtime - 
                       fs.statSync(path.join('knowledge-management/insights/puml', a)).mtime);
    
    if (generatedFiles.length > 0) {
      const latestFile = generatedFiles[0];
      console.log(`\n📂 PlantUML Filename Check:`);
      console.log(`  Latest: ${latestFile}`);
      
      if (latestFile.includes('implementationDocumentationStr')) {
        console.log(`  ❌ ISSUE: Malformed filename detected`);
      } else {
        console.log(`  ✅ Filename appears normal`);
      }
    }
    
    // Issue 2: Git analysis performance
    if (execution.results.analyze_git_history) {
      const gitTiming = execution.stepExecutions?.find(s => s.name === 'analyze_git_history');
      if (gitTiming) {
        const duration = gitTiming.endTime - gitTiming.startTime;
        console.log(`\n⚡ Git Analysis Performance:`);
        console.log(`  Duration: ${duration}ms`);
        console.log(`  Expected: 10-5000ms (updated threshold)`);
        console.log(`  Status: ${duration >= 10 ? '✅ Within range' : '❌ Too fast'}`);
      }
    }
    
    // Issue 3: LLM calls
    const semanticTiming = execution.stepExecutions?.find(s => s.name === 'semantic_analysis');
    if (semanticTiming) {
      const duration = semanticTiming.endTime - semanticTiming.startTime;
      console.log(`\n🤖 Semantic Analysis (LLM) Performance:`);
      console.log(`  Duration: ${duration}ms`);
      console.log(`  Expected: 3000-15000ms (for genuine LLM calls)`);
      console.log(`  Status: ${duration >= 3000 ? '✅ Likely used LLM' : '❌ Too fast (likely skipped)'}`);
      
      // Check for rate limit issues
      if (duration < 3000 && execution.errors?.some(e => e.includes('rate_limit'))) {
        console.log(`  ⚠️  Rate limit detected - this explains the fast completion`);
      }
    }
    
    // Issue 4: Overall system health
    console.log(`\n🏥 Overall System Health:`);
    const issues = [];
    
    if (generatedFiles.some(f => f.includes('implementationDocumentationStr'))) {
      issues.push('PlantUML filename generation');
    }
    
    if (!execution.results.analyze_git_history?.commits?.length) {
      issues.push('Git history not extracting commits');
    }
    
    if (!execution.results.semantic_analysis?.insights?.length) {
      issues.push('Semantic analysis not generating insights');
    }
    
    if (execution.errors?.some(e => e.includes('rate_limit'))) {
      issues.push('Rate limiting affecting LLM calls');
    }
    
    if (issues.length === 0) {
      console.log(`  ✅ All systems operational`);
    } else {
      console.log(`  ❌ Issues detected:`);
      issues.forEach(issue => console.log(`    - ${issue}`));
    }
    
  } catch (error) {
    console.error('\n❌ Workflow execution failed:', error.message);
    console.error('Stack:', error.stack);
  }
  
  console.log('\n' + '=' .repeat(60));
  console.log('🏁 Comprehensive E2E Test completed!');
}

// Run the test
runComprehensiveE2ETest().catch(console.error);