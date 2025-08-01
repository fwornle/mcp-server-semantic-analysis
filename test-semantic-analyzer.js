#!/usr/bin/env node

import { SemanticAnalyzer } from "./dist/agents/semantic-analyzer.js";

async function testSemanticAnalyzer() {
    console.log("Testing SemanticAnalyzer directly...");
    
    try {
        const analyzer = new SemanticAnalyzer();
        console.log("SemanticAnalyzer created successfully");
        
        const result = await analyzer.analyzeContent("Test content for semantic analysis with patterns and insights.", {
            context: "Direct test of semantic analyzer",
            analysisType: "general",
            provider: "anthropic"
        });
        
        console.log("Analysis completed:");
        console.log("- Has result:", !!result);
        console.log("- Result type:", typeof result);
        console.log("- Result keys:", result ? Object.keys(result) : null);
        console.log("- Provider:", result?.provider);
        console.log("- Insights length:", result?.insights?.length || 0);
        console.log("- Insights preview:", result?.insights?.substring(0, 200) + '...');
        
    } catch (error) {
        console.error("Test failed:");
        console.error("- Error type:", error.constructor.name);
        console.error("- Error message:", error.message);
        console.error("- Stack:", error.stack);
    }
}

testSemanticAnalyzer().catch(console.error);