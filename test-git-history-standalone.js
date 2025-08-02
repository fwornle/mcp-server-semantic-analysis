#!/usr/bin/env node

/**
 * Standalone Git History Agent Test
 * Tests the GitHistoryAgent in isolation to identify specific issues
 */

import { GitHistoryAgent } from './dist/agents/git-history-agent.js';
import { log } from './dist/logging.js';

async function testGitHistoryAgent() {
  console.log('🔍 Starting standalone Git History Agent test...\n');
  
  const agent = new GitHistoryAgent('.');
  
  // Test 1: Basic git history analysis
  console.log('📊 Test 1: Basic git history analysis');
  console.log('=====================================');
  
  const startTime = Date.now();
  
  try {
    const result = await agent.analyzeGitHistory({
      repository_path: '.',
      checkpoint_enabled: false,
      depth: 10, // Smaller depth for testing
      days_back: 7  // Last 7 days only
    });
    
    const duration = Date.now() - startTime;
    
    console.log(`✅ Analysis completed in ${duration}ms`);
    console.log(`📈 Result type: ${typeof result}`);
    console.log(`📊 Result keys: ${Object.keys(result || {}).join(', ')}`);
    
    if (result && result.commits) {
      console.log(`📝 Commits found: ${result.commits.length}`);
      console.log(`📅 Date range: ${result.analysis_period?.start} to ${result.analysis_period?.end}`);
      console.log(`📈 Total changes: ${result.total_changes || 0}`);
      console.log(`📁 Files modified: ${result.files_changed || 0}`);
      
      // Log first few commits for verification
      if (result.commits.length > 0) {
        console.log('\n🔍 First 3 commits:');
        result.commits.slice(0, 3).forEach((commit, i) => {
          console.log(`  ${i + 1}. ${commit.hash?.substr(0, 8)} - ${commit.message?.substr(0, 50)}... (${commit.date})`);
        });
      }
      
      // Check for recent commits (last 24 hours)
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentCommits = result.commits.filter(c => new Date(c.date) > yesterday);
      console.log(`🕐 Recent commits (last 24h): ${recentCommits.length}`);
      
    } else {
      console.log('❌ No commits found in result');
    }
    
  } catch (error) {
    console.error('❌ Test 1 failed:', error.message);
    console.error('Stack:', error.stack);
  }
  
  // Test 2: Performance analysis
  console.log('\n\n⚡ Test 2: Performance analysis');
  console.log('===============================');
  
  const performanceRuns = [];
  
  for (let i = 0; i < 3; i++) {
    console.log(`Run ${i + 1}/3...`);
    const runStart = Date.now();
    
    try {
      const result = await agent.analyzeGitHistory({
        repository_path: '.',
        checkpoint_enabled: false,
        depth: 5,
        days_back: 3
      });
      
      const runDuration = Date.now() - runStart;
      performanceRuns.push({
        duration: runDuration,
        commitsFound: result?.commits?.length || 0,
        success: true
      });
      
      console.log(`  ✅ ${runDuration}ms (${result?.commits?.length || 0} commits)`);
      
    } catch (error) {
      performanceRuns.push({
        duration: Date.now() - runStart,
        error: error.message,
        success: false
      });
      console.log(`  ❌ ${Date.now() - runStart}ms (error: ${error.message})`);
    }
  }
  
  // Performance statistics
  const successfulRuns = performanceRuns.filter(r => r.success);
  if (successfulRuns.length > 0) {
    const avgDuration = successfulRuns.reduce((sum, r) => sum + r.duration, 0) / successfulRuns.length;
    const minDuration = Math.min(...successfulRuns.map(r => r.duration));
    const maxDuration = Math.max(...successfulRuns.map(r => r.duration));
    
    console.log(`\n📊 Performance Summary:`);
    console.log(`  Average: ${avgDuration.toFixed(1)}ms`);
    console.log(`  Range: ${minDuration}ms - ${maxDuration}ms`);
    console.log(`  Success rate: ${successfulRuns.length}/3`);
    
    // Compare against QA expectations
    const qaExpectation = { min: 5000, ideal: 30000, max: 120000 }; // From QA agent
    console.log(`\n🎯 QA Comparison:`);
    console.log(`  Expected: ${qaExpectation.min}ms - ${qaExpectation.max}ms`);
    console.log(`  Actual avg: ${avgDuration.toFixed(1)}ms`);
    if (avgDuration < qaExpectation.min) {
      console.log(`  ⚠️  ISSUE: Running faster than QA minimum (${avgDuration.toFixed(1)}ms < ${qaExpectation.min}ms)`);
    } else if (avgDuration > qaExpectation.max) {
      console.log(`  ⚠️  ISSUE: Running slower than QA maximum (${avgDuration.toFixed(1)}ms > ${qaExpectation.max}ms)`);
    } else {
      console.log(`  ✅ Within QA expectations`);
    }
  }
  
  // Test 3: Data validation
  console.log('\n\n✅ Test 3: Data validation');
  console.log('==========================');
  
  try {
    const result = await agent.analyzeGitHistory({
      repository_path: '.',
      checkpoint_enabled: false,
      depth: 20,
      days_back: 14
    });
    
    // Validate result structure
    const validationResults = {
      hasCommits: !!(result && result.commits),
      hasAnalysisPeriod: !!(result && result.analysis_period),
      hasMetadata: !!(result && result.metadata),
      hasStats: !!(result && (result.total_changes !== undefined || result.files_changed !== undefined)),
      commitsHaveRequiredFields: true
    };
    
    if (result && result.commits) {
      // Check if commits have required fields
      const requiredFields = ['hash', 'message', 'date', 'author'];
      const incompleteCommits = result.commits.filter(commit => 
        !requiredFields.every(field => commit[field])
      );
      
      validationResults.commitsHaveRequiredFields = incompleteCommits.length === 0;
      
      if (incompleteCommits.length > 0) {
        console.log(`❌ ${incompleteCommits.length} commits missing required fields:`);
        incompleteCommits.slice(0, 3).forEach(commit => {
          const missingFields = requiredFields.filter(field => !commit[field]);
          console.log(`  - ${commit.hash || 'NO_HASH'}: missing ${missingFields.join(', ')}`);
        });
      }
    }
    
    console.log('📋 Validation Results:');
    Object.entries(validationResults).forEach(([key, value]) => {
      console.log(`  ${value ? '✅' : '❌'} ${key}: ${value}`);
    });
    
    // Detailed content check
    if (result && result.commits && result.commits.length > 0) {
      const sampleCommit = result.commits[0];
      console.log('\n🔍 Sample commit structure:');
      console.log(JSON.stringify(sampleCommit, null, 2));
    }
    
  } catch (error) {
    console.error('❌ Test 3 failed:', error.message);
  }
  
  console.log('\n🏁 Git History Agent standalone test completed!');
}

// Run the test
testGitHistoryAgent().catch(console.error);