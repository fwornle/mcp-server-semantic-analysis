#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";

async function testAnthropic() {
    console.log("Testing Anthropic API connectivity...");
    
    const apiKey = process.env.ANTHROPIC_API_KEY;
    console.log("API key available:", !!apiKey);
    console.log("API key length:", apiKey ? apiKey.length : 0);
    console.log("API key starts with:", apiKey ? apiKey.substring(0, 10) + '...' : 'none');
    
    if (!apiKey || apiKey === "your-anthropic-api-key") {
        console.error("ANTHROPIC_API_KEY not properly set");
        process.exit(1);
    }
    
    const client = new Anthropic({
        apiKey: apiKey,
    });
    
    try {
        console.log("Making test API call...");
        const response = await client.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 100,
            messages: [{ role: "user", content: "Hello! Please respond with a simple greeting." }]
        });
        
        console.log("Success! Response:");
        console.log("- Type:", response.content[0].type);
        console.log("- Text:", response.content[0].text);
        console.log("- Model:", response.model);
        console.log("- Usage:", response.usage);
        
    } catch (error) {
        console.error("API call failed:");
        console.error("- Error type:", error.constructor.name);
        console.error("- Error message:", error.message);
        if (error.status) {
            console.error("- HTTP status:", error.status);
        }
        console.error("- Full error:", error);
    }
}

testAnthropic().catch(console.error);