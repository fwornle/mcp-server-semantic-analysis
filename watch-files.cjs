#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Derive coding root from this file's location (2 levels up from integrations/mcp-server-semantic-analysis)
const codingRoot = process.env.CODING_TOOLS_PATH || process.env.CODING_REPO || path.resolve(__dirname, '../..');
const insightsDir = path.join(codingRoot, 'knowledge-management', 'insights');

console.log('🔍 Starting file watcher for insights directory...');
console.log('📁 Watching:', insightsDir);

// Watch for file changes
const watcher = fs.watch(insightsDir, { recursive: false }, (eventType, filename) => {
  if (filename && filename.endsWith('.md')) {
    const timestamp = new Date().toISOString();
    console.log(`🚨 FILE ${eventType.toUpperCase()}: ${filename} at ${timestamp}`);
    
    if (filename.includes('PatternDocumentation')) {
      const fullPath = path.join(insightsDir, filename);
      const stats = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
      console.log(`📊 SIZE: ${stats ? stats.size : 'DELETED'} bytes`);
      
      if (filename.includes('documentationupdates')) {
        console.log('🚨🚨🚨 CORRUPTION DETECTED IN FILENAME! 🚨🚨🚨');
      }
    }
  }
});

console.log('👁️  File watcher started. Press Ctrl+C to stop.');

process.on('SIGINT', () => {
  console.log('\n🛑 Stopping file watcher...');
  watcher.close();
  process.exit(0);
});

// Keep the process running
setInterval(() => {}, 1000);