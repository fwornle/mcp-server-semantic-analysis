// Direct trace of filename generation without full workflow
const path = require('path');

// Enable tracing
process.env.SEMANTIC_ANALYSIS_DEBUG = 'true';

console.log('🔍 TRACING: Loading insight generation agent...');

// Import the compiled JavaScript directly
const { InsightGenerationAgent } = require('./dist/agents/insight-generation-agent.js');

async function traceFilenameGeneration() {
  console.log('🏗️  Creating InsightGenerationAgent...');
  
  const agent = new InsightGenerationAgent(
    '/Users/q284340/Agentic/coding', 
    'coding'
  );
  
  console.log('📊 Creating mock pattern catalog with corrupted data...');
  
  // Create mock data that would cause corruption
  const mockPatternCatalog = {
    patterns: [
      {
        name: 'documentationupdatespattern', // This is likely how it comes in corrupted
        category: 'Implementation',
        significance: 9,
        description: 'Documentation updates pattern'
      },
      {
        name: 'Documentation Updates Pattern', // Clean version
        category: 'Implementation', 
        significance: 8,
        description: 'Clean documentation pattern'
      }
    ]
  };
  
  console.log('🧪 Testing filename generation with mock data...');
  console.log('Input patterns:', mockPatternCatalog.patterns.map(p => p.name));
  
  try {
    // This should trigger all our tracing
    const result = agent.generateMeaningfulNameAndTitle(
      {}, // gitAnalysis
      {}, // vibeAnalysis  
      {}, // semanticAnalysis
      mockPatternCatalog
    );
    
    console.log('📤 RESULT:');
    console.log('  name:', result.name);
    console.log('  title:', result.title);
    
    // Test with different corruption patterns
    console.log('\n🔬 Testing other corruption patterns...');
    
    const corruptionTests = [
      'PatternDocumentationupdatespattern',
      'documentationupdatespattern', 
      'Documentationupdates',
      'DocumentationUpdatesPattern' // Clean version
    ];
    
    corruptionTests.forEach((testPattern, i) => {
      console.log(`\n🧪 Test ${i + 1}: "${testPattern}"`);
      const testCatalog = {
        patterns: [{ name: testPattern, category: 'Test', significance: 5 }]
      };
      
      const testResult = agent.generateMeaningfulNameAndTitle({}, {}, {}, testCatalog);
      console.log(`  → Result: "${testResult.name}"`);
    });
    
  } catch (error) {
    console.error('❌ Error during filename generation:', error);
    console.error('Stack:', error.stack);
  }
}

console.log('🎯 Starting direct filename generation trace...');
traceFilenameGeneration().catch(console.error);