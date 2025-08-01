#!/usr/bin/env node

// Direct test of SemanticAnalyzer to debug MCP integration issue

import { SemanticAnalyzer } from "./dist/agents/semantic-analyzer.js";

async function testDirectLLM() {
  console.log("🚀 Testing SemanticAnalyzer directly...");
  
  const analyzer = new SemanticAnalyzer();
  
  const testContent = "This is a test of the semantic analysis system. We are checking if the LLM integration works through direct calls. The system should analyze this content and provide meaningful insights about the testing process and system integration.";
  
  console.log("📝 Test content length:", testContent.length);
  console.log("🔧 Calling analyzer.analyzeContent...");
  
  try {
    const result = await analyzer.analyzeContent(testContent, {
      context: "Testing direct LLM integration",
      analysisType: "general", 
      provider: "auto"
    });
    
    console.log("✅ Direct result:", {
      hasResult: !!result,
      resultType: typeof result,
      resultKeys: result ? Object.keys(result) : null,
      insightsLength: result?.insights?.length || 0,
      insightsPreview: result?.insights?.substring(0, 100) || 'No insights',
      provider: result?.provider || 'No provider'
    });
    
    if (result && result.insights) {
      console.log("🎯 SUCCESS: Direct LLM call works!");
      console.log("📊 Provider:", result.provider);
      console.log("📝 Insights preview:", result.insights.substring(0, 200) + "...");
    } else {
      console.log("❌ FAILED: Direct LLM call returned no insights");
      console.log("🔍 Full result:", JSON.stringify(result, null, 2));
    }
    
  } catch (error) {
    console.log("💥 ERROR in direct call:", error.message);
    console.log("📚 Stack:", error.stack);
  }
}

testDirectLLM().catch(console.error);