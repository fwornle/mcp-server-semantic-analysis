#!/usr/bin/env node

/**
 * Standalone Semantic Analysis Agent Test
 * Tests the SemanticAnalysisAgent in isolation to verify LLM integration
 */

import { SemanticAnalysisAgent } from './dist/agents/semantic-analysis-agent.js';
import { log } from './dist/logging.js';

async function testSemanticAnalysisAgent() {
  console.log('🧠 Starting standalone Semantic Analysis Agent test...\n');
  
  const agent = new SemanticAnalysisAgent();
  
  // Test 1: Basic semantic analysis with mock data
  console.log('📊 Test 1: Basic semantic analysis');
  console.log('==================================');
  
  const mockGitAnalysis = {
    commits: [
      {
        hash: "396f01f2",
        author: "fwornle", 
        date: "2025-08-01T11:07:55.000Z",
        message: "fix: all agents re-worked (as they didn't use any LLMs before)",
        files: [
          { path: "src/agents/semantic-analyzer.ts", status: "A", additions: 515, deletions: 0 },
          { path: "src/agents/insight-generation-agent.ts", status: "M", additions: 847, deletions: 323 }
        ],
        stats: { additions: 2437, deletions: 493, totalChanges: 2930 }
      }
    ],
    summary: "Major agent refactoring to include LLM integration"
  };
  
  const mockVibeAnalysis = {
    sessions: [
      { timestamp: "2025-08-01", content: "Agent improvements and LLM integration work" }
    ]
  };
  
  const startTime = Date.now();
  
  try {
    console.log('🔄 Calling analyzeSemantics with mock data...');
    const result = await agent.analyzeSemantics({
      git_analysis_results: mockGitAnalysis,
      vibe_analysis_results: mockVibeAnalysis
    });
    
    const duration = Date.now() - startTime;
    
    console.log(`✅ Analysis completed in ${duration}ms`);
    console.log(`📈 Result type: ${typeof result}`);
    console.log(`📊 Result keys: ${Object.keys(result || {}).join(', ')}`);
    
    if (result) {
      console.log(`🎯 Has patterns: ${!!(result.patterns)}`);
      console.log(`🔍 Has insights: ${!!(result.insights)}`); 
      console.log(`📊 Has correlations: ${!!(result.correlations)}`);
      console.log(`📈 Has metrics: ${!!(result.metrics)}`);
      
      if (result.patterns) {
        console.log(`📝 Patterns count: ${Array.isArray(result.patterns) ? result.patterns.length : 'N/A'}`);
      }
      
      if (result.insights) {
        console.log(`💡 Insights count: ${Array.isArray(result.insights) ? result.insights.length : 'N/A'}`);
      }
    }
    
    // QA timing comparison
    const qaExpectation = { min: 10000, ideal: 60000, max: 180000 }; // From QA agent
    console.log(`\n🎯 QA Timing Comparison:`);
    console.log(`  Expected: ${qaExpectation.min}ms - ${qaExpectation.max}ms`);
    console.log(`  Actual: ${duration}ms`);
    if (duration < qaExpectation.min) {
      console.log(`  ⚠️  ISSUE: Running faster than QA minimum (${duration}ms < ${qaExpectation.min}ms)`);
      console.log(`  🔍 This suggests LLM calls may be skipped or very fast`);
    } else {
      console.log(`  ✅ Within QA expectations`);
    }
    
  } catch (error) {
    console.error('❌ Test 1 failed:', error.message);
    console.error('Stack:', error.stack);
  }
  
  // Test 2: Direct LLM call test
  console.log('\n\n🤖 Test 2: Direct LLM integration test');
  console.log('======================================');
  
  // Access the semantic analyzer if available
  try {
    console.log('🔍 Testing direct LLM calls...');
    
    // Test if we can access the semantic analyzer
    const testContent = `
      // Sample code for analysis
      class TestPattern {
        constructor() {
          this.pattern = 'semantic-analysis-test';
        }
        
        analyze() {
          return 'test-result';
        }
      }
    `;
    
    const llmStartTime = Date.now();
    
    // This should trigger actual LLM analysis
    const result = await agent.analyzeSemantics({
      git_analysis_results: {
        commits: [{
          hash: "test123",
          message: "Test semantic analysis with sample code",
          files: [{ path: "test.js", content: testContent, additions: 10, deletions: 0 }]
        }],
        summary: "Test commit for semantic analysis"
      },
      vibe_analysis_results: {
        sessions: [{ content: "Testing semantic analysis capabilities" }]
      }
    });
    
    const llmDuration = Date.now() - llmStartTime;
    
    console.log(`🤖 LLM Analysis completed in ${llmDuration}ms`);
    
    if (llmDuration < 1000) {
      console.log(`⚠️  VERY FAST: ${llmDuration}ms suggests no actual LLM calls`);
    } else if (llmDuration < 5000) {
      console.log(`⚠️  FAST: ${llmDuration}ms might indicate cached or simple responses`);
    } else {
      console.log(`✅ NORMAL: ${llmDuration}ms suggests genuine LLM processing`);
    }
    
    // Check for meaningful content in result
    if (result && result.insights && result.insights.length > 0) {
      console.log(`✅ Generated ${result.insights.length} insights`);
      console.log(`🔍 Sample insight: ${result.insights[0]?.substring(0, 100)}...`);
    } else {
      console.log(`❌ No meaningful insights generated`);
    }
    
  } catch (error) {
    console.error('❌ Test 2 failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
  
  // Test 3: Performance consistency
  console.log('\n\n⚡ Test 3: Performance consistency');
  console.log('==================================');
  
  const performanceRuns = [];
  
  for (let i = 0; i < 3; i++) {
    console.log(`Run ${i + 1}/3...`);
    const runStart = Date.now();
    
    try {
      const result = await agent.analyzeSemantics({
        git_analysis_results: mockGitAnalysis,
        vibe_analysis_results: mockVibeAnalysis
      });
      
      const runDuration = Date.now() - runStart;
      performanceRuns.push({
        duration: runDuration,
        hasResult: !!result,
        hasInsights: !!(result && result.insights),
        success: true
      });
      
      console.log(`  ✅ ${runDuration}ms (result: ${!!result})`);
      
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
    console.log(`  Consistency: ${maxDuration - minDuration < 1000 ? 'High' : 'Variable'}`);
  }
  
  // Test 4: Configuration and capabilities check
  console.log('\n\n⚙️  Test 4: Configuration check');
  console.log('===============================');
  
  try {
    // Check if environment variables are set
    const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
    
    console.log(`🔑 Environment setup:`);
    console.log(`  ANTHROPIC_API_KEY: ${hasAnthropicKey ? '✅ Set' : '❌ Missing'}`);
    console.log(`  OPENAI_API_KEY: ${hasOpenAIKey ? '✅ Set' : '❌ Missing'}`);
    
    if (!hasAnthropicKey && !hasOpenAIKey) {
      console.log(`⚠️  NO API KEYS: This explains why LLM calls might be skipped!`);
    }
    
    // Check if agent has access to LLM functionality
    console.log(`\n🔍 Agent capabilities:`);
    console.log(`  Agent type: ${typeof agent}`);
    console.log(`  Available methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(agent)).filter(m => typeof agent[m] === 'function').join(', ')}`);
    
  } catch (error) {
    console.error('❌ Configuration check failed:', error.message);
  }
  
  console.log('\n🏁 Semantic Analysis Agent standalone test completed!');
}

// Run the test
testSemanticAnalysisAgent().catch(console.error);