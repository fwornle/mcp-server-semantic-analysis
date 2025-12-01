#!/usr/bin/env node

/**
 * Cleanup script to remove phantom nodes from .data/knowledge-export/coding.json
 * Removes entities that don't have corresponding insight files
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHARED_MEMORY_PATH = '../../.data/knowledge-export/coding.json';
const INSIGHTS_DIR = '../../knowledge-management/insights';

function main() {
  console.log('🧹 Cleaning up phantom nodes from knowledge base...');

  // Read knowledge base
  const knowledgeExportPath = path.resolve(__dirname, SHARED_MEMORY_PATH);
  const insightsDir = path.resolve(__dirname, INSIGHTS_DIR);
  
  if (!fs.existsSync(knowledgeExportPath)) {
    console.error('❌ Knowledge export file not found:', knowledgeExportPath);
    process.exit(1);
  }

  const knowledgeData = JSON.parse(fs.readFileSync(knowledgeExportPath, 'utf8'));
  const originalEntityCount = knowledgeData.entities.length;
  
  console.log(`📊 Original entities: ${originalEntityCount}`);
  
  // Check each entity for corresponding insight file
  const validEntities = [];
  const phantomEntities = [];

  for (const entity of knowledgeData.entities) {
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
  const validRelations = knowledgeData.relations.filter(rel =>
    !phantomNames.has(rel.from) && !phantomNames.has(rel.to)
  );

  const removedRelations = knowledgeData.relations.length - validRelations.length;

  // Update knowledge data
  knowledgeData.entities = validEntities;
  knowledgeData.relations = validRelations;
  knowledgeData.metadata.total_entities = validEntities.length;
  knowledgeData.metadata.total_relations = validRelations.length;
  knowledgeData.metadata.last_updated = new Date().toISOString();
  knowledgeData.metadata.cleanup_performed = new Date().toISOString();

  // Backup original file
  const backupPath = `${knowledgeExportPath}.backup-${Date.now()}`;
  fs.writeFileSync(backupPath, fs.readFileSync(knowledgeExportPath));
  console.log(`💾 Backup created: ${backupPath}`);

  // Write cleaned file
  fs.writeFileSync(knowledgeExportPath, JSON.stringify(knowledgeData, null, 2));
  
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