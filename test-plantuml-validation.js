#!/usr/bin/env node

/**
 * PlantUML Validation Test
 * Checks PlantUML files for syntax errors and validates structure
 */

import * as fs from 'fs';
import * as path from 'path';

class PlantUMLValidator {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  validateFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const issues = [];

    // Check for required start/end tags
    if (!content.includes('@startuml')) {
      issues.push({ type: 'error', line: 1, message: 'Missing @startuml directive' });
    }

    if (!content.includes('@enduml')) {
      issues.push({ type: 'error', line: lines.length, message: 'Missing @enduml directive' });
    }

    // Check each line for common syntax errors
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("'") || trimmed.startsWith('!')) {
        return;
      }

      // Check for malformed component definitions
      if (trimmed.startsWith('component ') && trimmed.includes('\\n')) {
        issues.push({
          type: 'error',
          line: lineNum,
          message: 'Invalid component definition with escaped newline (should use separate lines or quotes)',
          suggestion: `Use: component "Name" as Alias\n       or: component Name`
        });
      }

      // Check for unmatched quotes
      const quotes = (trimmed.match(/"/g) || []).length;
      if (quotes % 2 !== 0) {
        issues.push({
          type: 'error',
          line: lineNum,
          message: 'Unmatched quotes in line'
        });
      }

      // Check for malformed relationships
      if (trimmed.includes('-->') || trimmed.includes('--')) {
        const relationshipPattern = /^[\w\s"]+\s*(-->|-->\s*|\.\.|\.\.>|\-\-|\-\->|\=\=|\=\=>)\s*[\w\s"]+\s*(:.*)?$/;
        if (!relationshipPattern.test(trimmed) && !trimmed.includes('note') && !trimmed.includes('legend')) {
          issues.push({
            type: 'warning',
            line: lineNum,
            message: 'Potentially malformed relationship syntax'
          });
        }
      }

      // Check for common PlantUML keywords without proper syntax
      const keywords = ['participant', 'actor', 'boundary', 'control', 'entity', 'database', 'collections'];
      keywords.forEach(keyword => {
        if (trimmed.startsWith(keyword + ' ') && !trimmed.match(new RegExp(`^${keyword}\\s+\\w+`))) {
          issues.push({
            type: 'warning',
            line: lineNum,
            message: `Possibly malformed ${keyword} definition`
          });
        }
      });

      // Check for very long lines that might cause rendering issues
      if (trimmed.length > 200) {
        issues.push({
          type: 'warning',
          line: lineNum,
          message: 'Very long line may cause rendering issues'
        });
      }
    });

    return {
      file: filePath,
      issues,
      isValid: issues.filter(i => i.type === 'error').length === 0
    };
  }

  validateDirectory(dirPath) {
    const results = [];
    
    function walkDir(dir) {
      const files = fs.readdirSync(dir);
      
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          walkDir(fullPath);
        } else if (file.endsWith('.puml')) {
          results.push(fullPath);
        }
      }
    }
    
    walkDir(dirPath);
    
    return results.map(filePath => this.validateFile(filePath));
  }

  generateFixedContent(filePath, issues) {
    const content = fs.readFileSync(filePath, 'utf8');
    let lines = content.split('\n');

    // Apply automatic fixes for common issues
    lines = lines.map((line, index) => {
      const lineNum = index + 1;
      const relevantIssues = issues.filter(i => i.line === lineNum);

      let fixedLine = line;

      relevantIssues.forEach(issue => {
        if (issue.message.includes('Invalid component definition with escaped newline')) {
          // Fix: component "Name" as Alias\ncomponent "Name2" as Alias2
          // Should be: component "Name" as Alias
          //           component "Name2" as Alias2
          if (fixedLine.includes('\\n')) {
            const parts = fixedLine.split('\\n');
            if (parts.length === 2) {
              fixedLine = parts[0]; // Take first part, second will be handled separately
              // Add the second part as a new line after this one
              lines.splice(index + 1, 0, parts[1]);
            }
          }
        }
      });

      return fixedLine;
    });

    return lines.join('\n');
  }
}

function runPlantUMLValidation() {
  console.log('🌱 Starting PlantUML Validation Test\n');

  const validator = new PlantUMLValidator();
  
  // Validate files in the insights directory
  const insightsDir = '/Users/q284340/Agentic/coding/knowledge-management/insights/puml';
  
  if (!fs.existsSync(insightsDir)) {
    console.log('❌ PlantUML directory not found:', insightsDir);
    return;
  }

  console.log(`📂 Validating PlantUML files in: ${insightsDir}`);
  
  try {
    const results = validator.validateDirectory(insightsDir);
    
    console.log(`\n📊 Validation Summary:`);
    console.log(`  Files checked: ${results.length}`);
    
    let totalErrors = 0;
    let totalWarnings = 0;
    let validFiles = 0;
    let invalidFiles = 0;

    results.forEach(result => {
      const errors = result.issues.filter(i => i.type === 'error');
      const warnings = result.issues.filter(i => i.type === 'warning');
      
      totalErrors += errors.length;
      totalWarnings += warnings.length;
      
      if (result.isValid) {
        validFiles++;
      } else {
        invalidFiles++;
      }

      if (result.issues.length > 0) {
        console.log(`\n📁 ${path.basename(result.file)}:`);
        
        if (errors.length > 0) {
          console.log(`  🔴 Errors (${errors.length}):`);
          errors.forEach(error => {
            console.log(`    Line ${error.line}: ${error.message}`);
            if (error.suggestion) {
              console.log(`    💡 Suggestion: ${error.suggestion}`);
            }
          });
        }

        if (warnings.length > 0) {
          console.log(`  🟡 Warnings (${warnings.length}):`);
          warnings.forEach(warning => {
            console.log(`    Line ${warning.line}: ${warning.message}`);
          });
        }

        // Generate and show fixed content for files with errors
        if (errors.length > 0) {
          console.log(`\n🔧 Attempting automatic fix...`);
          try {
            const fixedContent = validator.generateFixedContent(result.file, errors);
            const backupPath = result.file + '.backup';
            
            // Create backup
            fs.copyFileSync(result.file, backupPath);
            console.log(`  💾 Backup created: ${path.basename(backupPath)}`);
            
            // Write fixed content
            fs.writeFileSync(result.file, fixedContent);
            console.log(`  ✅ Fixed file written`);

            // Re-validate
            const revalidated = validator.validateFile(result.file);
            if (revalidated.isValid) {
              console.log(`  ✅ File is now valid!`);
            } else {
              console.log(`  ⚠️  Some issues remain after automatic fix`);
            }
            
          } catch (fixError) {
            console.log(`  ❌ Automatic fix failed: ${fixError.message}`);
          }
        }
      }
    });

    console.log(`\n📈 Overall Results:`);
    console.log(`  ✅ Valid files: ${validFiles}`);
    console.log(`  ❌ Invalid files: ${invalidFiles}`);
    console.log(`  🔴 Total errors: ${totalErrors}`);
    console.log(`  🟡 Total warnings: ${totalWarnings}`);

    if (invalidFiles === 0) {
      console.log(`\n🎉 All PlantUML files are valid!`);
    } else {
      console.log(`\n⚠️  ${invalidFiles} files need attention`);
    }

  } catch (error) {
    console.error('❌ Validation failed:', error.message);
  }

  console.log('\n🏁 PlantUML validation completed!');
}

// Run the validation
runPlantUMLValidation().catch(console.error);