#!/usr/bin/env node

// Debug MCP server integration issue

import { handleToolCall } from "./dist/tools.js";

async function testMCPHandler() {
  console.log("🚀 Testing MCP handler directly...");
  
  const args = {
    content: "This is a test of the semantic analysis system through MCP handler. We are checking if the LLM integration works properly.",
    context: "Testing MCP handler integration",
    analysis_type: "general",
    provider: "auto"
  };
  
  console.log("📝 Test args:", args);
  console.log("🔧 Calling handleToolCall('determine_insights', args)...");
  
  try {
    const result = await handleToolCall("determine_insights", args);
    
    console.log("✅ MCP Handler result:", {
      hasResult: !!result,
      resultType: typeof result,
      hasContent: !!result?.content,
      contentLength: result?.content?.length || 0
    });
    
    if (result?.content?.[0]?.text) {
      const text = result.content[0].text;
      console.log("📄 Result text preview:", text.substring(0, 300) + "...");
      
      // Check if insights are undefined
      if (text.includes("undefined")) {
        console.log("❌ FOUND UNDEFINED in result text!");
        console.log("🔍 Full text:\n", text);
      } else {
        console.log("🎯 SUCCESS: MCP handler works properly!");
      }
    } else {
      console.log("❌ No text content in result");
      console.log("🔍 Full result:", JSON.stringify(result, null, 2));
    }
    
  } catch (error) {
    console.log("💥 ERROR in MCP handler:", error.message);
    console.log("📚 Stack:", error.stack);
  }
}

// Also test environment variables in MCP context
console.log("🔑 Environment check:");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "SET" : "NOT SET");
console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "SET" : "NOT SET");

testMCPHandler().catch(console.error);