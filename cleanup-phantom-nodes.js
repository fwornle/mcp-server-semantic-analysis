#!/usr/bin/env node

/**
 * Cleanup script to remove phantom nodes from shared-memory-coding.json
 * Removes entities that don't have corresponding insight files
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHARED_MEMORY_PATH = '../../shared-memory-coding.json';
const INSIGHTS_DIR = '../../knowledge-management/insights';

function main() {
  console.log('🧹 Cleaning up phantom nodes from shared memory...');
  
  // Read shared memory
  const sharedMemoryPath = path.resolve(__dirname, SHARED_MEMORY_PATH);
  const insightsDir = path.resolve(__dirname, INSIGHTS_DIR);
  
  if (!fs.existsSync(sharedMemoryPath)) {
    console.error('❌ Shared memory file not found:', sharedMemoryPath);
    process.exit(1);
  }
  
  const sharedMemory = JSON.parse(fs.readFileSync(sharedMemoryPath, 'utf8'));
  const originalEntityCount = sharedMemory.entities.length;
  
  console.log(`📊 Original entities: ${originalEntityCount}`);
  
  // Check each entity for corresponding insight file
  const validEntities = [];
  const phantomEntities = [];
  
  for (const entity of sharedMemory.entities) {
    const insightFilePath = path.join(insightsDir, `${entity.name}.md`);
    
    if (fs.existsSync(insightFilePath)) {
      validEntities.push(entity);
      console.log(`✅ ${entity.name} - file exists`);
    } else {
      phantomEntities.push(entity);
      console.log(`👻 ${entity.name} - PHANTOM (no file)`);
    }
  }
  
  // Clean up relations that reference phantom entities
  const phantomNames = new Set(phantomEntities.map(e => e.name));
  const validRelations = sharedMemory.relations.filter(rel => 
    !phantomNames.has(rel.from) && !phantomNames.has(rel.to)
  );
  
  const removedRelations = sharedMemory.relations.length - validRelations.length;
  
  // Update shared memory
  sharedMemory.entities = validEntities;
  sharedMemory.relations = validRelations;
  sharedMemory.metadata.total_entities = validEntities.length;
  sharedMemory.metadata.total_relations = validRelations.length;
  sharedMemory.metadata.last_updated = new Date().toISOString();
  sharedMemory.metadata.cleanup_performed = new Date().toISOString();
  
  // Backup original file
  const backupPath = `${sharedMemoryPath}.backup-${Date.now()}`;
  fs.writeFileSync(backupPath, fs.readFileSync(sharedMemoryPath));
  console.log(`💾 Backup created: ${backupPath}`);
  
  // Write cleaned file
  fs.writeFileSync(sharedMemoryPath, JSON.stringify(sharedMemory, null, 2));
  
  console.log('\n🎯 Cleanup Results:');
  console.log(`   Valid entities: ${validEntities.length}`);
  console.log(`   Phantom entities removed: ${phantomEntities.length}`);
  console.log(`   Relations removed: ${removedRelations}`);
  console.log('');
  console.log('📋 Removed phantom entities:');
  phantomEntities.forEach(e => console.log(`   - ${e.name} (${e.entityType})`));
  
  console.log('\n✅ Cleanup completed successfully!');
}

main();