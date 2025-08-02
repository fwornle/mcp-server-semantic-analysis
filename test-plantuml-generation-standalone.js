#!/usr/bin/env node

/**
 * Standalone PlantUML Generation Test
 * Tests the PlantUML filename generation and content creation in isolation
 */

import { InsightGenerationAgent } from './dist/agents/insight-generation-agent.js';
import { log } from './dist/logging.js';
import * as fs from 'fs';
import * as path from 'path';

async function testPlantUMLGeneration() {
  console.log('🌱 Starting standalone PlantUML Generation test...\n');
  
  const agent = new InsightGenerationAgent();
  
  // Test 1: Filename generation with various inputs
  console.log('📂 Test 1: Filename generation');
  console.log('==============================');
  
  const testCases = [
    {
      name: 'Empty analysis',
      analysisResult: {},
      expectedIssue: 'Should use fallback naming'
    },
    {
      name: 'Malformed data',
      analysisResult: {
        insights: "DocumentationupdatesimplementationDocumentationStr",
        patterns: undefined
      },
      expectedIssue: 'Should clean malformed strings'
    },
    {
      name: 'Normal analysis',
      analysisResult: {
        insights: ['Code refactoring patterns', 'State management improvements'],
        patterns: ['SingletonPattern', 'ObserverPattern'],
        summary: 'Architecture analysis of the system'
      },
      expectedIssue: 'Should generate clean names'
    },
    {
      name: 'Very long strings',
      analysisResult: {
        insights: 'This is a very long insight string that should be truncated to prevent extremely long filenames that would cause filesystem issues',
        summary: 'Long summary text'
      },
      expectedIssue: 'Should truncate appropriately'
    }
  ];
  
  for (const testCase of testCases) {
    console.log(`\n🧪 Testing: ${testCase.name}`);
    
    try {
      // Test the generateMeaningfulNameAndTitle method
      const result = await agent.generateMeaningfulNameAndTitle(testCase.analysisResult);
      
      console.log(`  📝 Generated name: "${result.name}"`);
      console.log(`  📄 Generated title: "${result.title}"`);
      console.log(`  📏 Name length: ${result.name.length}`);
      
      // Validate filename
      const isValidFilename = /^[a-zA-Z0-9_-]+$/.test(result.name);
      const hasReasonableLength = result.name.length >= 3 && result.name.length <= 50;
      const notMalformed = !result.name.includes('implementationDocumentationStr');
      
      console.log(`  ✅ Valid filename: ${isValidFilename}`);
      console.log(`  ✅ Reasonable length: ${hasReasonableLength}`); 
      console.log(`  ✅ Not malformed: ${notMalformed}`);
      
      if (!isValidFilename || !hasReasonableLength || !notMalformed) {
        console.log(`  ❌ ISSUE: ${testCase.expectedIssue}`);
      } else {
        console.log(`  ✅ PASS: Filename generation working correctly`);
      }
      
    } catch (error) {
      console.error(`  ❌ Failed: ${error.message}`);
    }
  }
  
  // Test 2: Full PlantUML diagram generation
  console.log('\n\n🎨 Test 2: Full diagram generation');
  console.log('===================================');
  
  const mockAnalysisResult = {
    codeAnalysis: {
      patterns: [
        { name: 'SingletonPattern', significance: 8, description: 'Singleton implementation for database connection' },
        { name: 'ObserverPattern', significance: 7, description: 'Event system for UI updates' }
      ],
      insights: [
        'System uses proper separation of concerns',
        'Database layer is well abstracted',
        'Event handling could be improved'
      ],
      metrics: {
        complexity: 6.5,
        maintainability: 8.2,
        coverage: 75
      }
    },
    semanticInsights: [
      'Code follows SOLID principles',
      'Proper error handling implemented',
      'Some code duplication detected'
    ]
  };
  
  const diagramTypes = ['architecture', 'sequence', 'class', 'use-cases'];
  
  for (const diagramType of diagramTypes) {
    console.log(`\n🔧 Testing ${diagramType} diagram generation...`);
    
    try {
      const startTime = Date.now();
      
      const result = await agent.generatePlantUMLDiagrams(
        diagramType,
        'Test System Analysis',
        'TestSystemAnalysis',
        mockAnalysisResult
      );
      
      const duration = Date.now() - startTime;
      
      console.log(`  ⏱️  Generated in ${duration}ms`);
      console.log(`  📊 Result type: ${typeof result}`);
      
      if (result && result.files) {
        console.log(`  📁 Files generated: ${result.files.length}`);
        result.files.forEach(file => {
          console.log(`    - ${file.filename} (${file.content?.length || 0} chars)`);
          
          // Check filename format
          const isProperFormat = file.filename.endsWith('.puml');
          const hasReasonableName = !file.filename.includes('implementationDocumentationStr');
          
          console.log(`      ✅ Proper .puml extension: ${isProperFormat}`);
          console.log(`      ✅ Clean filename: ${hasReasonableName}`);
          
          // Check content quality
          if (file.content) {
            const hasPlantUMLStart = file.content.includes('@startuml');
            const hasPlantUMLEnd = file.content.includes('@enduml'); 
            const hasTitle = file.content.includes('title');
            const hasComponents = file.content.split('\n').length > 10;
            
            console.log(`      ✅ Valid PlantUML format: ${hasPlantUMLStart && hasPlantUMLEnd}`);
            console.log(`      ✅ Has title: ${hasTitle}`);
            console.log(`      ✅ Has substantial content: ${hasComponents}`);
            
            if (!hasComponents) {
              console.log(`      ⚠️  Content may be too minimal (${file.content.split('\n').length} lines)`);
            }
          }
        });
      } else {
        console.log(`  ❌ No files generated or malformed result`);
      }
      
    } catch (error) {
      console.error(`  ❌ ${diagramType} generation failed:`, error.message);
    }
  }
  
  // Test 3: Edge case handling
  console.log('\n\n⚠️  Test 3: Edge case handling');
  console.log('==============================');
  
  const edgeCases = [
    {
      name: 'Null analysis result',
      analysisResult: null,
      expectError: false
    },
    {
      name: 'Empty analysis result',
      analysisResult: {},
      expectError: false
    },
    {
      name: 'Analysis with special characters',
      analysisResult: {
        insights: ['Test with special chars: @#$%^&*()'],
        patterns: [{ name: 'Pattern-With-Dashes', description: 'Test/Pattern\\With/Slashes' }]
      },
      expectError: false
    }
  ];
  
  for (const edgeCase of edgeCases) {
    console.log(`\n🧪 Testing edge case: ${edgeCase.name}`);
    
    try {
      const result = await agent.generatePlantUMLDiagrams(
        'architecture',
        'Edge Case Test',
        'EdgeCaseTest',
        edgeCase.analysisResult
      );
      
      if (edgeCase.expectError) {
        console.log(`  ❌ Expected error but got result`);
      } else {
        console.log(`  ✅ Handled gracefully`);
        if (result && result.files && result.files.length > 0) {
          const filename = result.files[0].filename;
          console.log(`  📝 Generated filename: ${filename}`);
          console.log(`  ✅ Safe filename: ${!/[^a-zA-Z0-9_.-]/.test(filename)}`);
        }
      }
      
    } catch (error) {
      if (edgeCase.expectError) {
        console.log(`  ✅ Correctly threw error: ${error.message}`);
      } else {
        console.log(`  ❌ Unexpected error: ${error.message}`);
      }
    }
  }
  
  // Test 4: Performance and consistency
  console.log('\n\n⚡ Test 4: Performance and consistency');
  console.log('=====================================');
  
  const performanceRuns = [];
  
  for (let i = 0; i < 3; i++) {
    console.log(`Run ${i + 1}/3...`);
    const runStart = Date.now();
    
    try {
      const result = await agent.generatePlantUMLDiagrams(
        'architecture',
        'Performance Test',
        'PerformanceTest',
        mockAnalysisResult
      );
      
      const runDuration = Date.now() - runStart;
      performanceRuns.push({
        duration: runDuration,
        filesGenerated: result?.files?.length || 0,
        success: true
      });
      
      console.log(`  ✅ ${runDuration}ms (${result?.files?.length || 0} files)`);
      
    } catch (error) {
      performanceRuns.push({
        duration: Date.now() - runStart,
        error: error.message,
        success: false
      });
      console.log(`  ❌ ${Date.now() - runStart}ms (error: ${error.message})`);
    }
  }
  
  // Performance summary
  const successfulRuns = performanceRuns.filter(r => r.success);
  if (successfulRuns.length > 0) {
    const avgDuration = successfulRuns.reduce((sum, r) => sum + r.duration, 0) / successfulRuns.length;
    const minDuration = Math.min(...successfulRuns.map(r => r.duration));
    const maxDuration = Math.max(...successfulRuns.map(r => r.duration));
    
    console.log(`\n📊 Performance Summary:`);
    console.log(`  Average: ${avgDuration.toFixed(1)}ms`);
    console.log(`  Range: ${minDuration}ms - ${maxDuration}ms`);
    console.log(`  Success rate: ${successfulRuns.length}/3`);
    console.log(`  Consistency: ${maxDuration - minDuration < 100 ? 'High' : 'Variable'}`);
  }
  
  console.log('\n🏁 PlantUML Generation standalone test completed!');
}

// Run the test
testPlantUMLGeneration().catch(console.error);