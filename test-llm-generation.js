#!/usr/bin/env node

// Simple test to isolate LLM diagram generation issue
import { InsightGenerationAgent } from './dist/agents/insight-generation-agent.js';
import { setupLogging } from './dist/logging.js';
import path from 'path';
import { fileURLToPath } from 'url';

// Derive the coding repo root from this file's location
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// This file is at: integrations/mcp-server-semantic-analysis/
// Coding root is 2 levels up
const codingRoot = process.env.CODING_TOOLS_PATH || process.env.CODING_REPO || path.resolve(__dirname, '../..');

// Setup logging
setupLogging();

async function testLLMGeneration() {
  console.log('🧪 Testing LLM diagram generation isolation...');

  // Create agent with correct repository path
  const agent = new InsightGenerationAgent(codingRoot);
  
  // Test data with substantial content like debug script
  const testData = {
    gitAnalysis: {
      checkpointInfo: {
        fromTimestamp: null,
        toTimestamp: "2025-08-03T14:39:36.000Z",
        commitsAnalyzed: 24
      },
      commits: Array(24).fill().map((_, i) => ({
        hash: `hash${i}`,
        author: "developer",
        date: "2025-08-03T12:00:00.000Z",
        message: `Commit ${i}: Implement semantic analysis features`,
        files: [
          { path: `src/agents/semantic-analysis-${i}.ts`, status: "M", changes: 150 },
          { path: `src/utils/analysis-${i}.ts`, status: "A", changes: 200 },
          { path: `tests/analysis-${i}.test.ts`, status: "A", changes: 100 }
        ]
      })),
      architecturalDecisions: 45,
      patterns: 9
    },
    vibeAnalysis: { 
      sessions: [],
      contextsExtracted: 0,
      problemSolutionPairs: 0
    },
    semanticAnalysis: { 
      insights: "Comprehensive semantic analysis of TypeScript codebase with MCP integration. Found 21 files totaling 16,322 lines of code with 159 functions. Primary patterns include agent development, multi-agent coordination, and semantic analysis workflows.",
      files: 21,
      patterns: 5,
      confidence: 1,
      patternsFound: ["AgentDevelopmentPattern", "SemanticAnalysisPattern", "MCPIntegrationPattern"],
      codeQuality: {
        totalLines: 16322,
        totalFunctions: 159,
        averageComplexity: 37.43,
        highComplexityFiles: 15
      }
    },
    patternCatalog: {
      patterns: [
        {
          name: "AgentDevelopmentPattern",
          category: "Architecture",
          significance: 9,
          description: "Multi-agent system pattern for semantic analysis coordination",
          occurrences: 19,
          technologies: ["TypeScript", "Node.js", "MCP"],
          codeExamples: [
            "class SemanticAnalysisAgent { async analyzeRepository() { ... } }",
            "class GitHistoryAgent { async extractCommits() { ... } }"
          ]
        },
        {
          name: "MCPIntegrationPattern", 
          category: "Integration",
          significance: 8,
          description: "Model Context Protocol integration for AI tool orchestration",
          occurrences: 12,
          technologies: ["MCP", "JSON-RPC", "Claude"],
          codeExamples: [
            "server.setRequestHandler(ListToolsRequestSchema, async () => { ... })",
            "const result = await handleExecuteWorkflow(args);"
          ]
        }
      ],
      summary: {
        totalPatterns: 2,
        byCategory: { "Architecture": 1, "Integration": 1 },
        avgSignificance: 8.5,
        topPatterns: ["AgentDevelopmentPattern", "MCPIntegrationPattern"]
      }
    }
  };
  
  console.log('📋 Test data prepared');
  console.log('🔥 Git analysis exists:', !!testData.gitAnalysis);
  console.log('🔥 Pattern catalog exists:', !!testData.patternCatalog);
  
  try {
    console.log('🚀 Calling generateLLMEnhancedDiagram directly...');
    const result = await agent.generateLLMEnhancedDiagram('architecture', testData);
    
    console.log('📊 RESULT:');
    console.log('- Length:', result ? result.length : 0);
    console.log('- Contains @startuml:', result ? result.includes('@startuml') : false);
    console.log('- First 200 chars:', result ? result.substring(0, 200) : 'NO RESULT');
    
    if (!result) {
      console.error('❌ LLM generation returned empty result!');
    } else {
      console.log('✅ LLM generation successful!');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testLLMGeneration().catch(console.error);