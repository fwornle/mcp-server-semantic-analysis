#!/usr/bin/env python3
"""Test the enhanced MCP server functionality"""

import os
import asyncio

# Check if enhanced functionality is working
class TestEngine:
    def __init__(self):
        self.has_openai = bool(os.getenv('OPENAI_API_KEY')) and os.getenv('OPENAI_API_KEY') != 'your-openai-api-key'
        self.has_anthropic = bool(os.getenv('ANTHROPIC_API_KEY')) and os.getenv('ANTHROPIC_API_KEY') != 'your-anthropic-api-key'
    
    async def test_providers(self):
        print(f"OpenAI configured: {self.has_openai}")
        print(f"Anthropic configured: {self.has_anthropic}")
        
        if self.has_openai or self.has_anthropic:
            return {"enhanced": True, "providers": ["openai" if self.has_openai else "", "anthropic" if self.has_anthropic else ""]}
        else:
            return {"enhanced": False, "fallback": True}

async def main():
    engine = TestEngine()
    result = await engine.test_providers()
    print("Test result:", result)

if __name__ == "__main__":
    asyncio.run(main())