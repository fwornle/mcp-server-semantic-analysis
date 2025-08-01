#!/usr/bin/env node

console.log("Environment variables test:");
console.log("ANTHROPIC_API_KEY:", !!process.env.ANTHROPIC_API_KEY ? `Set (${process.env.ANTHROPIC_API_KEY.length} chars)` : "Not set");
console.log("OPENAI_API_KEY:", !!process.env.OPENAI_API_KEY ? `Set (${process.env.OPENAI_API_KEY.length} chars)` : "Not set");
console.log("OPENAI_BASE_URL:", process.env.OPENAI_BASE_URL || "Not set");
console.log("NODE_ENV:", process.env.NODE_ENV || "Not set");
console.log("Working directory:", process.cwd());
console.log("Node version:", process.version);