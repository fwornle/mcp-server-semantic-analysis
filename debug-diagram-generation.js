#!/usr/bin/env node

// Debug script to test PlantUML diagram generation directly
import { InsightGenerationAgent } from './dist/agents/insight-generation-agent.js';
import { setupLogging, log } from './dist/logging.js';

// Setup logging
setupLogging();

async function testDiagramGeneration() {
  console.log('🔍 Starting PlantUML diagram generation debug test...');
  
  const agent = new InsightGenerationAgent();
  
  // Test data similar to what would come from semantic analysis
  const testData = {
    patternCatalog: {
      patterns: [
        {
          name: "VSCodeExtensionBridgePattern",
          category: "Integration", 
          significance: 9,
          description: "Bridge pattern for VSCode extension integration"
        },
        {
          name: "ConfigurationPattern",
          category: "Configuration",
          significance: 8, 
          description: "Configuration management pattern"
        }
      ],
      summary: {
        totalPatterns: 2,
        byCategory: { "Integration": 1, "Configuration": 1 },
        avgSignificance: 8.5,
        topPatterns: ["VSCodeExtensionBridgePattern", "ConfigurationPattern"]
      }
    },
    content: "Multi-agent coding system with semantic analysis",
    name: "debug-architecture-test"
  };
  
  console.log('📋 Test data prepared:', JSON.stringify(testData, null, 2));
  
  try {
    console.log('🚀 Calling generateLLMEnhancedDiagram...');
    const result = await agent.generateLLMEnhancedDiagram('architecture', testData);
    
    console.log('✅ Result:', result ? `Generated ${result.length} characters` : 'No result');
    if (result) {
      console.log('📄 First 200 chars:', result.substring(0, 200));
    }
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

testDiagramGeneration().catch(console.error);