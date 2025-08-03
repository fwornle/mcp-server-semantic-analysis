#!/usr/bin/env node

// Debug script to test insight generation directly
const path = require('path');

async function debugInsightGeneration() {
  console.log('🔍 Starting debug insight generation test...\n');
  
  // Load the compiled modules
  const { InsightGenerationAgent } = require('./dist/agents/insight-generation-agent.js');
  const { GitHistoryAgent } = require('./dist/agents/git-history-agent.js');
  const { VibeHistoryAgent } = require('./dist/agents/vibe-history-agent.js');
  const { SemanticAnalysisAgent } = require('./dist/agents/semantic-analysis-agent.js');
  
  try {
    // Initialize agents
    console.log('📋 Initializing agents...');
    const gitAgent = new GitHistoryAgent();
    const vibeAgent = new VibeHistoryAgent();
    const semanticAgent = new SemanticAnalysisAgent();
    const insightAgent = new InsightGenerationAgent();
    
    // Run minimal analysis
    console.log('\n📊 Running git history analysis...');
    const gitAnalysis = await gitAgent.analyzeGitHistory();
    console.log(`  ✓ Found ${gitAnalysis.commits?.length || 0} commits`);
    console.log('  📊 GitAnalysis structure preview:');
    console.log('    - commits:', gitAnalysis.commits?.length || 0);
    console.log('    - files property:', gitAnalysis.files ? 'exists' : 'missing');
    console.log('    - first commit files:', gitAnalysis.commits?.[0]?.files?.length || 0);
    
    console.log('\n💭 Running vibe history analysis...');
    const vibeAnalysis = await vibeAgent.analyzeVibeHistory();
    console.log(`  ✓ Found ${vibeAnalysis.sessions?.length || 0} sessions`);
    
    console.log('\n🔬 Running semantic analysis...');
    const semanticAnalysis = await semanticAgent.analyzeSemantics({ 
      git_analysis_results: gitAnalysis,
      vibe_analysis_results: vibeAnalysis,
      incremental: false
    });
    console.log('  ✓ Semantic analysis complete');
    
    // Generate insights with debugging
    console.log('\n🎯 Generating insights...');
    console.log('  [Set breakpoint at insight-generation-agent.ts:1054 to debug]');
    
    const insights = await insightAgent.generateComprehensiveInsights({
      gitAnalysis,
      vibeAnalysis,
      semanticAnalysis,
      patternCatalog: { patterns: [] },
      webResults: []
    });
    
    console.log('\n✅ Insight generation complete!');
    console.log('\n📄 Generated insight preview:');
    console.log(typeof insights === 'string' ? insights.substring(0, 500) + '...' : JSON.stringify(insights, null, 2).substring(0, 500) + '...');
    
  } catch (error) {
    console.error('\n❌ Error during debug:', error);
    console.error(error.stack);
  }
}

// Run the debug script
debugInsightGeneration().catch(console.error);