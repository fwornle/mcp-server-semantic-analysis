/**
 * Single source of truth for filename generation
 * NO OTHER CODE should manipulate filenames - use this utility only
 */

export interface FileNaming {
  filename: string;  // Clean filename for .md files
  entityName: string; // Name for knowledge base entities
}

export class FilenameGenerator {
  /**
   * Generate clean filename from analysis results
   * This is the ONLY place where filenames are generated
   */
  static generateFromAnalysis(
    gitAnalysis?: any,
    vibeAnalysis?: any, 
    semanticAnalysis?: any,
    patternCatalog?: any
  ): FileNaming {
    
    // Get the most significant pattern if available
    const topPattern = patternCatalog?.patterns
      ?.sort((a: any, b: any) => b.significance - a.significance)?.[0];
    
    let baseName: string;
    
    console.log('FilenameGenerator DEBUG:', {
      topPatternName: topPattern?.name,
      hasPatterns: patternCatalog?.patterns?.length,
      allPatternNames: patternCatalog?.patterns?.map((p: any) => p.name)
    });
    
    if (topPattern?.name) {
      // CRITICAL: Fix corrupted input at source
      console.log('Fixing corrupted pattern name:', topPattern.name);
      baseName = this.fixCorruptedPatternName(topPattern.name);
      console.log('Fixed to:', baseName);
    } else if (gitAnalysis?.summary?.focusAreas?.[0]) {
      baseName = this.toCamelCase(gitAnalysis.summary.focusAreas[0]) + 'Pattern';
    } else {
      baseName = 'SemanticAnalysisPattern';
    }
    
    console.log('Final filename:', baseName);
    
    return {
      filename: baseName,
      entityName: baseName + 'Analysis' + new Date().toISOString().split('T')[0]
    };
  }
  
  /**
   * Fix corrupted pattern names that come from upstream
   */
  private static fixCorruptedPatternName(name: string): string {
    // Handle common corruption patterns
    if (name.includes('documentationupdates')) {
      return 'DocumentationUpdatesPattern';
    }
    if (name.includes('configuration')) {
      return 'ConfigurationPattern';
    }
    if (name.includes('testfile')) {
      return 'TestFilePattern';
    }
    if (name.includes('bugfix')) {
      return 'BugFixPattern';
    }
    
    // Generic fix: convert to proper CamelCase
    return this.toCamelCase(name);
  }
  
  /**
   * Convert any string to clean CamelCase
   */
  private static toCamelCase(str: string): string {
    return str
      .toLowerCase()
      .split(/[\s\-_]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }
  
  /**
   * Generate filename from pattern name directly
   */
  static generateFromPattern(patternName: string): FileNaming {
    const filename = patternName.replace(/\s+/g, '');
    
    return {
      filename,
      entityName: filename + 'Analysis' + new Date().toISOString().split('T')[0]
    };
  }
}