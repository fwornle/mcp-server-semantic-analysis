#!/bin/bash
# Install critical dependencies in system Python as a fallback
# This is NOT the preferred solution - using venv is better

echo "⚠️  WARNING: Installing packages in system Python is not recommended!"
echo "   Preferred solution: Fix MCP to use venv Python"
echo ""
echo "If you still want to proceed, this will install:"
echo "  - anthropic (for Claude API)"
echo "  - mcp (for MCP server functionality)"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Installing critical packages in system Python..."
    
    # Use pip3 explicitly to ensure system Python
    /Library/Frameworks/Python.framework/Versions/3.12/bin/pip3 install anthropic mcp
    
    echo "✅ Installation complete"
    echo "Note: This is a workaround. The proper fix is to make MCP use venv."
else
    echo "❌ Installation cancelled"
fi