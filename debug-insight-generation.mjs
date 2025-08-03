#!/usr/bin/env node

// Debug script to test insight generation directly
import { InsightGenerationAgent } from './dist/agents/insight-generation-agent.js';
import { GitHistoryAgent } from './dist/agents/git-history-agent.js';
import { VibeHistoryAgent } from './dist/agents/vibe-history-agent.js';
import { SemanticAnalysisAgent } from './dist/agents/semantic-analysis-agent.js';

async function debugInsightGeneration() {
  console.log('🔍 Starting debug insight generation test...\n');
  
  try {
    // Initialize agents
    console.log('📋 Initializing agents...');
    const gitAgent = new GitHistoryAgent();
    const vibeAgent = new VibeHistoryAgent();
    const semanticAgent = new SemanticAnalysisAgent();
    const insightAgent = new InsightGenerationAgent();
    
    // Run minimal analysis
    console.log('\n📊 Running git history analysis...');
    const gitAnalysis = await gitAgent.analyze({ limit: 5 });
    console.log(`  ✓ Found ${gitAnalysis.commits?.length || 0} commits`);
    
    console.log('\n💭 Running vibe history analysis...');
    const vibeAnalysis = await vibeAgent.analyze({ limit: 5 });
    console.log(`  ✓ Found ${vibeAnalysis.sessions?.length || 0} sessions`);
    
    console.log('\n🔬 Running semantic analysis...');
    const semanticAnalysis = await semanticAgent.analyze({ 
      targetPath: process.cwd(),
      filePatterns: ['*.ts', '*.js']
    });
    console.log('  ✓ Semantic analysis complete');
    console.log('  - Code quality issues:', semanticAnalysis?.codeAnalysis?.codeQuality?.issues);
    
    // Generate insights with debugging
    console.log('\n🎯 Generating insights...');
    console.log('  [Watch for DEBUG output to see problem statement flow]');
    
    const insights = await insightAgent.generateInsights({
      gitAnalysis,
      vibeAnalysis,
      semanticAnalysis,
      patternCatalog: { patterns: [] },
      webResults: []
    });
    
    console.log('\n✅ Insight generation complete!');
    
    // Extract the problem statement from the generated markdown
    const problemMatch = insights.match(/\*\*Problem:\*\* (.+)/);
    if (problemMatch) {
      console.log('\n📌 Generated Problem Statement:');
      console.log('  "' + problemMatch[1] + '"');
    }
    
  } catch (error) {
    console.error('\n❌ Error during debug:', error);
    console.error(error.stack);
  }
}

// Run the debug script
debugInsightGeneration().catch(console.error);