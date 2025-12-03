import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';

export interface QualityAssuranceReport {
  stepName: string;
  passed: boolean;
  errors: string[];
  warnings: string[];
  corrected: boolean;
  correctedOutput?: any;
  validationTime: Date;
  score: number; // 0-100
  details: {
    structureCompliance: number;
    contentQuality: number;
    namingConventions: number;
    completeness: number;
  };
}

export interface ValidationRules {
  entityNaming: {
    camelCase: boolean;
    noSpaces: boolean;
    descriptive: boolean;
    maxLength: number;
  };
  observations: {
    minCount: number;
    requiredTypes: string[];
    maxLength: number;
    hasLinks: boolean;
  };
  significance: {
    validRange: [number, number];
    allowedValues: number[];
  };
  files: {
    insightFiles: boolean;
    diagramFiles: boolean;
    extensions: string[];
  };
  knowledgeBase: {
    entityExists: boolean;
    relationshipsValid: boolean;
    synchronizedWithMCP: boolean;
  };
}

export class QualityAssuranceAgent {
  private rules: ValidationRules;
  private repositoryPath: string;
  private semanticAnalyzer: SemanticAnalyzer;
  private team: string;

  constructor(repositoryPath: string = '.', team: string = 'coding') {
    this.repositoryPath = repositoryPath;
    this.team = team;
    this.rules = this.getDefaultRules();
    this.semanticAnalyzer = new SemanticAnalyzer();
    this.initializeRules();
  }

  private getDefaultRules(): ValidationRules {
    return {
      entityNaming: {
        camelCase: true,
        noSpaces: true,
        descriptive: true,
        maxLength: 50
      },
      observations: {
        minCount: 1,
        requiredTypes: ['insight', 'implementation'],
        maxLength: 1000,
        hasLinks: false
      },
      significance: {
        validRange: [1, 10],
        allowedValues: [5, 8, 9]
      },
      files: {
        insightFiles: true,
        diagramFiles: false,
        extensions: ['.md', '.puml']
      },
      knowledgeBase: {
        entityExists: true,
        relationshipsValid: true,
        synchronizedWithMCP: false
      }
    };
  }

  private initializeRules(): void {
    // Load any custom rules from configuration
    log('QualityAssuranceAgent initialized with default rules', 'info');
  }

  private async validateStepTiming(
    stepName: string,
    timing: { startTime: Date; endTime: Date; timeout: number },
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    const duration = timing.endTime.getTime() - timing.startTime.getTime();
    const durationSeconds = duration / 1000;
    const timeoutSeconds = timing.timeout;

    log(`Validating timing for ${stepName}`, 'info', {
      durationSeconds,
      timeoutSeconds,
      utilizationPercent: (durationSeconds / timeoutSeconds) * 100
    });

    // Realistic timing thresholds based on actual measured performance
    const timingExpectations: Record<string, { min: number; ideal: number; max: number }> = {
      'analyze_git_history': { min: 0.01, ideal: 0.5, max: 5 },        // Actually runs 20-80ms
      'analyze_vibe_history': { min: 0.01, ideal: 0.5, max: 5 },       // Similar to git history
      'semantic_analysis': { min: 3, ideal: 8, max: 15 },              // Actually runs 4-8 seconds with LLM
      'web_search': { min: 0.1, ideal: 2, max: 10 },                   // Quick web operations
      'generate_insights': { min: 3, ideal: 8, max: 20 },              // Similar to semantic analysis
      'generate_observations': { min: 0.1, ideal: 2, max: 10 },        // Data processing
      'quality_assurance': { min: 0.05, ideal: 0.2, max: 2 },         // Fast validation
      'persist_results': { min: 0.05, ideal: 0.5, max: 3 }            // File I/O operations
    };

    const expected = timingExpectations[stepName] || { min: 1, ideal: 30, max: 120 };

    // Performance analysis
    if (durationSeconds < expected.min) {
      warnings.push(`Step ${stepName} completed suspiciously fast (${durationSeconds.toFixed(1)}s < ${expected.min}s) - may indicate incomplete processing`);
    } else if (durationSeconds > expected.max) {
      errors.push(`Step ${stepName} exceeded maximum expected duration (${durationSeconds.toFixed(1)}s > ${expected.max}s) - performance concern`);
    } else if (durationSeconds > expected.ideal * 1.5) {
      warnings.push(`Step ${stepName} took longer than ideal (${durationSeconds.toFixed(1)}s > ${expected.ideal * 1.5}s) - consider optimization`);
    }

    // Timeout utilization analysis
    const utilizationPercent = (durationSeconds / timeoutSeconds) * 100;
    if (utilizationPercent > 90) {
      errors.push(`Step ${stepName} used ${utilizationPercent.toFixed(1)}% of timeout (${durationSeconds.toFixed(1)}s/${timeoutSeconds}s) - timeout too aggressive`);
    } else if (utilizationPercent > 75) {
      warnings.push(`Step ${stepName} used ${utilizationPercent.toFixed(1)}% of timeout - consider increasing timeout buffer`);
    } else if (utilizationPercent < 10 && timeoutSeconds > 60) {
      warnings.push(`Step ${stepName} timeout may be too generous (${utilizationPercent.toFixed(1)}% utilization) - consider optimization`);
    }

    // LLM-specific timing validation (updated based on actual performance)
    if (stepName === 'semantic_analysis' || stepName === 'generate_insights') {
      if (durationSeconds < 2) {
        errors.push(`LLM step ${stepName} completed too quickly (${durationSeconds.toFixed(1)}s) - likely skipped LLM calls`);
      } else if (durationSeconds < 3) {
        warnings.push(`LLM step ${stepName} may not have used LLM analysis (${durationSeconds.toFixed(1)}s) - verify API calls`);
      }
    }

    // File I/O intensive steps timing (updated for git operations)
    if (stepName === 'analyze_git_history' || stepName === 'analyze_vibe_history') {
      if (durationSeconds < 0.01) {
        warnings.push(`File analysis step ${stepName} completed extremely quickly - may indicate insufficient file processing`);
      }
    }
  }

  async performComprehensiveQA(
    stepName: string,
    stepResult: any,
    expectedOutputs?: string[],
    stepTiming?: { startTime: Date; endTime: Date; timeout: number }
  ): Promise<QualityAssuranceReport> {
    log(`Starting QA validation for step: ${stepName}`, 'info', {
      stepName,
      hasResult: !!stepResult,
      expectedOutputs: expectedOutputs?.length || 0,
      hasTiming: !!stepTiming
    });

    const startTime = new Date();
    const errors: string[] = [];
    const warnings: string[] = [];
    let corrected = false;
    let correctedOutput = undefined;

    // Enhanced timing validation
    if (stepTiming) {
      await this.validateStepTiming(stepName, stepTiming, errors, warnings);
    }

    try {
      // Debug log for all validations
      console.log(`[QA DEBUG] Starting step-specific validation for: ${stepName}`, {
        hasStepResult: !!stepResult,
        stepResultType: typeof stepResult,
        isSemanticAnalysis: stepName === 'semantic_analysis'
      });
      log(`Starting step-specific validation for: ${stepName}`, 'info', {
        hasStepResult: !!stepResult,
        stepResultType: typeof stepResult,
        isSemanticAnalysis: stepName === 'semantic_analysis'
      });
      
      // Step-specific validations
      switch (stepName) {
        case 'analyze_git_history':
          await this.validateGitHistoryAnalysis(stepResult, errors, warnings);
          break;
          
        case 'analyze_vibe_history':
          await this.validateVibeHistoryAnalysis(stepResult, errors, warnings);
          break;
          
        case 'semantic_analysis':
          log('About to validate semantic analysis step', 'info', {
            hasStepResult: !!stepResult,
            stepResultType: typeof stepResult,
            stepResultKeys: stepResult ? Object.keys(stepResult).filter(k => !k.startsWith('_')) : []
          });
          await this.validateSemanticAnalysis(stepResult, errors, warnings);
          break;
          
        case 'web_search_patterns':
          await this.validateWebSearchResults(stepResult, errors, warnings);
          break;
          
        case 'generate_insights':
          await this.validateInsightGeneration(stepResult, errors, warnings);
          break;
          
        case 'generate_observations':
          const correctionResult = await this.validateAndCorrectObservations(stepResult, errors, warnings);
          if (correctionResult.corrected) {
            corrected = true;
            correctedOutput = correctionResult.correctedOutput;
          }
          break;
          
        case 'persist_knowledge':
          await this.validateKnowledgePersistence(stepResult, errors, warnings);
          break;
          
        default:
          warnings.push(`Unknown step type: ${stepName} - performing generic validation`);
          await this.validateGenericOutput(stepResult, errors, warnings);
      }

      // Calculate quality scores
      const details = this.calculateQualityScores(stepResult, errors, warnings);
      const overallScore = this.calculateOverallScore(details, errors.length, warnings.length);

      const report: QualityAssuranceReport = {
        stepName,
        passed: errors.length === 0,
        errors,
        warnings,
        corrected,
        correctedOutput,
        validationTime: startTime,
        score: overallScore,
        details
      };

      log(`QA validation completed for ${stepName}`, 'info', {
        passed: report.passed,
        errors: errors.length,
        warnings: warnings.length,
        score: overallScore,
        corrected
      });

      return report;

    } catch (error) {
      log(`QA validation failed for ${stepName}`, 'error', error);
      errors.push(`QA validation error: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        stepName,
        passed: false,
        errors,
        warnings,
        corrected: false,
        validationTime: startTime,
        score: 0,
        details: {
          structureCompliance: 0,
          contentQuality: 0,
          namingConventions: 0,
          completeness: 0
        }
      };
    }
  }

  /**
   * Validate PlantUML files for syntax errors and structural issues
   */
  private validatePlantUMLFile(filePath: string): { isValid: boolean; issues: any[] } {
    if (!fs.existsSync(filePath)) {
      return { isValid: false, issues: [{ type: 'error', message: 'File not found' }] };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const issues: any[] = [];

    // Check for required start/end tags
    if (!content.includes('@startuml')) {
      issues.push({ type: 'error', line: 1, message: 'Missing @startuml directive' });
    }

    if (!content.includes('@enduml')) {
      issues.push({ type: 'error', line: lines.length, message: 'Missing @enduml directive' });
    }

    // Check each line for syntax errors
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("'") || trimmed.startsWith('!')) {
        return;
      }

      // REMOVED: \n in component definitions is VALID PlantUML syntax for multi-line labels
      // Do NOT flag this as an error!

      // Check for unmatched quotes
      const quotes = (trimmed.match(/"/g) || []).length;
      if (quotes % 2 !== 0) {
        issues.push({
          type: 'error',
          line: lineNum,
          message: 'Unmatched quotes in line'
        });
      }

      // Check for very long lines
      if (trimmed.length > 200) {
        issues.push({
          type: 'warning',
          line: lineNum,
          message: 'Very long line may cause rendering issues'
        });
      }
    });

    const errors = issues.filter(i => i.type === 'error');
    return { isValid: errors.length === 0, issues };
  }

  /**
   * REMOVED: Auto-fix was corrupting valid PlantUML files by removing \n from multi-line labels
   * PlantUML component labels can contain \n for multi-line text - this is VALID syntax
   */
  private fixPlantUMLFile(filePath: string): boolean {
    // DO NOT AUTO-FIX PUML FILES - manual review required
    return false;
  }

  /**
   * Validate all PlantUML files in generated artifacts
   */
  private async validateGeneratedPlantUMLFiles(errors: string[], warnings: string[]): Promise<void> {
    const pumlDirs = [
      path.join(this.repositoryPath, 'knowledge-management', 'insights', 'puml'),
      path.join(this.repositoryPath, 'docs', 'puml')
    ];

    let totalFiles = 0;
    let validFiles = 0;
    let fixedFiles = 0;

    for (const pumlDir of pumlDirs) {
      if (!fs.existsSync(pumlDir)) continue;

      const files = fs.readdirSync(pumlDir).filter(f => f.endsWith('.puml'));
      
      for (const file of files) {
        const filePath = path.join(pumlDir, file);
        totalFiles++;

        const validation = this.validatePlantUMLFile(filePath);
        
        if (validation.isValid) {
          validFiles++;
        } else {
          const errorCount = validation.issues.filter(i => i.type === 'error').length;
          const warningCount = validation.issues.filter(i => i.type === 'warning').length;

          if (errorCount > 0) {
            errors.push(`PlantUML file ${file} has ${errorCount} syntax errors`);
            
            // Attempt automatic fix
            if (this.fixPlantUMLFile(filePath)) {
              fixedFiles++;
              
              // Re-validate after fix
              const revalidation = this.validatePlantUMLFile(filePath);
              if (revalidation.isValid) {
                validFiles++;
                warnings.push(`PlantUML file ${file} was automatically fixed`);
              } else {
                errors.push(`PlantUML file ${file} still has errors after attempted fix`);
              }
            }
          }

          if (warningCount > 0) {
            warnings.push(`PlantUML file ${file} has ${warningCount} style warnings`);
          }
        }
      }
    }

    if (totalFiles > 0) {
      log(`PlantUML validation completed`, 'info', {
        totalFiles,
        validFiles,
        fixedFiles,
        validationRate: `${Math.round(validFiles / totalFiles * 100)}%`
      });

      if (validFiles < totalFiles) {
        errors.push(`${totalFiles - validFiles} PlantUML files have validation issues`);
      }
    }
  }

  /**
   * Validate PNG files for PlantUML error output (black background with green text).
   * PlantUML generates error images instead of failing, so we need to detect them by analyzing image content.
   */
  private async validateGeneratedPNGFiles(errors: string[], warnings: string[]): Promise<void> {
    const pngDirs = [
      path.join(this.repositoryPath, 'knowledge-management', 'insights', 'images'),
      path.join(this.repositoryPath, 'docs', 'images')
    ];

    // Detection thresholds for PlantUML error images
    const ERROR_DETECTION = {
      BLACK_THRESHOLD: 30,
      GREEN_MIN_G: 200,
      GREEN_MAX_R: 100,
      GREEN_MAX_B: 100,
      MIN_BLACK_PERCENTAGE: 40,
      MIN_GREEN_PERCENTAGE: 5,
    };

    let totalFiles = 0;
    let errorFiles = 0;
    const brokenFiles: string[] = [];

    for (const pngDir of pngDirs) {
      if (!fs.existsSync(pngDir)) continue;

      const files = fs.readdirSync(pngDir).filter(f => f.endsWith('.png'));

      for (const file of files) {
        const filePath = path.join(pngDir, file);
        totalFiles++;

        try {
          // Use sharp to analyze the PNG (already a dependency via @xenova/transformers)
          const sharp = await import('sharp');
          const image = sharp.default(filePath);
          const metadata = await image.metadata();
          const { width, height } = metadata;

          if (!width || !height) {
            warnings.push(`PNG file ${file} has invalid dimensions`);
            continue;
          }

          // Get raw pixel data
          const { data } = await image.raw().toBuffer({ resolveWithObject: true });

          const totalPixels = width * height;
          let blackPixels = 0;
          let greenPixels = 0;

          // Analyze pixels (3 channels: R, G, B)
          for (let i = 0; i < data.length; i += 3) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            // Check for black
            if (r <= ERROR_DETECTION.BLACK_THRESHOLD &&
                g <= ERROR_DETECTION.BLACK_THRESHOLD &&
                b <= ERROR_DETECTION.BLACK_THRESHOLD) {
              blackPixels++;
            }

            // Check for bright green (PlantUML error text color)
            if (g >= ERROR_DETECTION.GREEN_MIN_G &&
                r <= ERROR_DETECTION.GREEN_MAX_R &&
                b <= ERROR_DETECTION.GREEN_MAX_B) {
              greenPixels++;
            }
          }

          const blackPercentage = (blackPixels / totalPixels) * 100;
          const greenPercentage = (greenPixels / totalPixels) * 100;

          // Detect error image: high black AND has green text
          const isError = blackPercentage >= ERROR_DETECTION.MIN_BLACK_PERCENTAGE &&
                         greenPercentage >= ERROR_DETECTION.MIN_GREEN_PERCENTAGE;

          if (isError) {
            errorFiles++;
            brokenFiles.push(file);
            errors.push(`PNG file ${file} contains PlantUML error output (${blackPercentage.toFixed(1)}% black, ${greenPercentage.toFixed(1)}% green)`);
          }
        } catch (error) {
          warnings.push(`Failed to analyze PNG file ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (totalFiles > 0) {
      log('PNG error detection completed', 'info', {
        totalFiles,
        errorFiles,
        validFiles: totalFiles - errorFiles,
        brokenFiles: brokenFiles.slice(0, 5)
      });

      if (errorFiles > 0) {
        errors.push(`CRITICAL: ${errorFiles} PNG files contain PlantUML error output instead of valid diagrams`);
      }
    }
  }

  /**
   * Validates that all PNG image references in insight markdown files actually exist.
   * Also detects inconsistent formatting (some diagrams showing PNG, others showing PUML link).
   */
  private async validateInsightMarkdownImages(errors: string[], warnings: string[]): Promise<void> {
    const insightsDir = path.join(this.repositoryPath, 'knowledge-management', 'insights');
    const imagesDir = path.join(insightsDir, 'images');

    if (!fs.existsSync(insightsDir)) return;

    const mdFiles = fs.readdirSync(insightsDir).filter(f => f.endsWith('.md'));

    for (const mdFile of mdFiles) {
      const mdPath = path.join(insightsDir, mdFile);
      const content = fs.readFileSync(mdPath, 'utf8');

      // Find all PNG image references: ![...](images/xxx.png)
      const pngRefs = content.match(/!\[.*?\]\(images\/([^)]+\.png)\)/g) || [];
      const pumlFallbacks = content.match(/📄 \*\*\[View.*?Diagram Source\]\(puml\/[^)]+\.puml\)\*\*/g) || [];

      // Check if referenced PNGs exist
      for (const ref of pngRefs) {
        const match = ref.match(/!\[.*?\]\(images\/([^)]+\.png)\)/);
        if (match) {
          const pngName = match[1];
          const pngPath = path.join(imagesDir, pngName);
          if (!fs.existsSync(pngPath)) {
            errors.push(`${mdFile}: Missing PNG file - ${pngName}`);
          }
        }
      }

      // Detect inconsistent diagram formatting (mix of PNG and PUML-only references)
      if (pngRefs.length > 0 && pumlFallbacks.length > 0) {
        warnings.push(`${mdFile}: Inconsistent diagram formatting - ${pngRefs.length} PNG refs, ${pumlFallbacks.length} PUML-only refs`);

        // Extract which diagrams fell back to PUML-only
        for (const fallback of pumlFallbacks) {
          const typeMatch = fallback.match(/View ([^)]+?) Diagram Source/);
          if (typeMatch) {
            const diagramType = typeMatch[1];
            // Check if PNG actually exists for this diagram
            const baseName = mdFile.replace('.md', '');
            const expectedPng = `${baseName}_${diagramType.toLowerCase().replace(' ', '-')}.png`;
            const pngPath = path.join(imagesDir, expectedPng);

            if (fs.existsSync(pngPath)) {
              errors.push(`${mdFile}: PNG exists but not referenced - ${expectedPng} (should update markdown to use PNG)`);
            } else {
              warnings.push(`${mdFile}: ${diagramType} diagram missing PNG - ${expectedPng}`);
            }
          }
        }
      }
    }

    log('Insight markdown image validation completed', 'info', {
      filesChecked: mdFiles.length
    });
  }

  // New comprehensive workflow QA method
  async performWorkflowQA(parameters: { all_results: Record<string, any> }): Promise<any> {
    const { all_results } = parameters;
    
    log('Starting comprehensive workflow QA', 'info', {
      stepsToValidate: Object.keys(all_results).length
    });

    const validations: Record<string, QualityAssuranceReport> = {};
    let overallPassed = true;
    let totalErrors = 0;
    let totalWarnings = 0;

    // Validate each step individually with timing data
    for (const [stepName, stepResult] of Object.entries(all_results)) {
      if (stepResult && typeof stepResult === 'object') {
        const timing = stepResult._timing ? {
          startTime: new Date(stepResult._timing.startTime),
          endTime: new Date(stepResult._timing.endTime),
          timeout: stepResult._timing.timeout
        } : undefined;

        const cleanResult = { ...stepResult };
        delete cleanResult._timing; // Remove timing data for validation

        const report = await this.performComprehensiveQA(stepName, cleanResult, undefined, timing);
        validations[stepName] = report;

        if (!report.passed) {
          overallPassed = false;
        }
        totalErrors += report.errors.length;
        totalWarnings += report.warnings.length;
      }
    }

    // Workflow-level validations
    const workflowErrors: string[] = [];
    const workflowWarnings: string[] = [];

    await this.validateWorkflowIntegrity(all_results, workflowErrors, workflowWarnings);
    await this.validateWorkflowTiming(all_results, workflowErrors, workflowWarnings);
    await this.validateGeneratedPlantUMLFiles(workflowErrors, workflowWarnings);
    await this.validateGeneratedPNGFiles(workflowErrors, workflowWarnings);
    await this.validateInsightMarkdownImages(workflowErrors, workflowWarnings);

    const result = {
      validations,
      workflowLevel: {
        passed: workflowErrors.length === 0 && overallPassed,
        errors: workflowErrors,
        warnings: workflowWarnings
      },
      summary: {
        totalSteps: Object.keys(all_results).length,
        passedSteps: Object.values(validations).filter(v => v.passed).length,
        totalErrors: totalErrors + workflowErrors.length,
        totalWarnings: totalWarnings + workflowWarnings.length,
        overallScore: this.calculateWorkflowScore(validations, workflowErrors, workflowWarnings)
      }
    };

    log('Workflow QA completed', 'info', {
      overallPassed: result.workflowLevel.passed,
      totalErrors: result.summary.totalErrors,
      totalWarnings: result.summary.totalWarnings,
      overallScore: result.summary.overallScore
    });

    return result;
  }

  /**
   * Lightweight QA for incremental analysis - faster checks focused on essential validation
   * Skips heavy operations like LLM-based content validation and comprehensive PlantUML checks
   */
  async performLightweightQA(parameters: { all_results: Record<string, any>, lightweight?: boolean }): Promise<any> {
    const { all_results } = parameters;

    log('Starting lightweight workflow QA for incremental analysis', 'info', {
      stepsToValidate: Object.keys(all_results).length
    });

    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Check insights were generated with valid structure
    const insightsResult = all_results.insights;
    if (insightsResult) {
      if (insightsResult.insightDocument) {
        // Validate insight document has required fields
        const doc = insightsResult.insightDocument;
        if (!doc.name || !doc.title || !doc.content) {
          errors.push('Insight document missing required fields (name, title, or content)');
        }
        if (!doc.filePath) {
          errors.push('Insight document missing filePath - MD file may not have been written');
        }

        // Check for orphan diagrams - diagrams exist but no corresponding MD file path
        if (doc.diagrams && doc.diagrams.length > 0 && !doc.filePath) {
          errors.push(`Potential orphan diagrams: ${doc.diagrams.length} diagrams generated but no MD file path`);
        }

        // Validate diagram success
        if (doc.diagrams) {
          const failedDiagrams = doc.diagrams.filter((d: any) => !d.success);
          if (failedDiagrams.length > 0) {
            warnings.push(`${failedDiagrams.length} diagram(s) failed to generate`);
          }
        }
      } else if (insightsResult.insightDocuments && insightsResult.insightDocuments.length > 0) {
        // Multiple documents - check each
        for (const doc of insightsResult.insightDocuments) {
          if (!doc.filePath) {
            errors.push(`Insight "${doc.name}" missing filePath`);
          }
        }
      } else {
        warnings.push('No insight documents found in results');
      }
    } else {
      errors.push('Insights result is missing from workflow output');
    }

    // 2. Check observations were generated
    const observationsResult = all_results.observations;
    if (observationsResult) {
      if (!observationsResult.observations || observationsResult.observations.length === 0) {
        warnings.push('No observations were generated');
      }
    }

    // 3. Validate data flow - git/vibe analysis should have produced semantic results
    const gitResult = all_results.git_history;
    const semanticResult = all_results.semantic_analysis;
    if (gitResult && gitResult.commits && gitResult.commits.length > 0) {
      if (!semanticResult || !semanticResult.analysis) {
        warnings.push('Git analysis found commits but semantic analysis may be incomplete');
      }
    }

    const passed = errors.length === 0;
    const score = passed ? 100 - (warnings.length * 5) : Math.max(0, 50 - (errors.length * 10));

    const result = {
      passed,
      errors,
      warnings,
      lightweight: true,
      summary: {
        checksPerformed: 3,
        errorsFound: errors.length,
        warningsFound: warnings.length,
        score
      }
    };

    log('Lightweight QA completed', 'info', {
      passed,
      errors: errors.length,
      warnings: warnings.length,
      score
    });

    return result;
  }

  private async validateWorkflowIntegrity(
    allResults: Record<string, any>,
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    // Check for data flow consistency
    const gitResult = allResults.git_history;
    const semanticResult = allResults.semantic_analysis;
    const insightsResult = allResults.insights;

    if (gitResult && semanticResult) {
      if (gitResult.commits?.length > 0 && !semanticResult.insights) {
        errors.push('Git analysis found commits but semantic analysis produced no insights - data flow broken');
      }
    }

    if (semanticResult && insightsResult) {
      if (semanticResult.insights && (!insightsResult.patternCatalog?.patterns || insightsResult.patternCatalog.patterns.length === 0)) {
        errors.push('Semantic analysis produced insights but insight generation found no patterns - processing failure');
      }
    }

    // Validate cross-step dependencies
    const expectedFlow = [
      ['git_history', 'semantic_analysis'],
      ['vibe_history', 'semantic_analysis'],
      ['semantic_analysis', 'insights'],
      ['insights', 'observations']
    ];

    for (const [prereq, dependent] of expectedFlow) {
      if (allResults[prereq] && allResults[dependent]) {
        if (allResults[prereq].error && !allResults[dependent].error) {
          warnings.push(`Step ${dependent} succeeded despite ${prereq} failure - may indicate incomplete processing`);
        }
      }
    }
  }

  private async validateWorkflowTiming(
    allResults: Record<string, any>,
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    const timings: Array<{ step: string; duration: number; startTime: Date }> = [];

    // Collect timing data
    for (const [stepName, result] of Object.entries(allResults)) {
      if (result?._timing) {
        timings.push({
          step: stepName,
          duration: result._timing.duration / 1000, // Convert to seconds
          startTime: new Date(result._timing.startTime)
        });
      }
    }

    if (timings.length === 0) {
      warnings.push('No timing data available for workflow analysis');
      return;
    }

    // Sort by start time to analyze sequential execution
    timings.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // Calculate total workflow time
    const firstStart = timings[0].startTime;
    const lastEnd = new Date(Math.max(...timings.map(t => 
      new Date(t.startTime.getTime() + t.duration * 1000).getTime()
    )));
    const totalWorkflowTime = (lastEnd.getTime() - firstStart.getTime()) / 1000;

    log('Workflow timing analysis', 'info', {
      totalSteps: timings.length,
      totalWorkflowTime: `${totalWorkflowTime.toFixed(1)}s`,
      slowestStep: timings.reduce((max, t) => t.duration > max.duration ? t : max).step
    });

    // Validate workflow efficiency
    if (totalWorkflowTime > 900) { // 15 minutes
      errors.push(`Workflow took too long: ${totalWorkflowTime.toFixed(1)}s > 900s - needs optimization`);
    } else if (totalWorkflowTime > 600) { // 10 minutes
      warnings.push(`Workflow approaching time limit: ${totalWorkflowTime.toFixed(1)}s - monitor performance`);
    }

    // Identify performance bottlenecks
    const slowSteps = timings.filter(t => t.duration > 120); // > 2 minutes
    if (slowSteps.length > 0) {
      warnings.push(`Performance bottlenecks detected: ${slowSteps.map(s => `${s.step}(${s.duration.toFixed(1)}s)`).join(', ')}`);
    }

    // Check for suspiciously fast steps
    const fastSteps = timings.filter(t => t.duration < 1); // < 1 second
    if (fastSteps.length > 2) {
      warnings.push(`Multiple steps completed very quickly: ${fastSteps.map(s => s.step).join(', ')} - verify completeness`);
    }
  }

  private calculateWorkflowScore(
    validations: Record<string, QualityAssuranceReport>,
    workflowErrors: string[],
    workflowWarnings: string[]
  ): number {
    const stepScores = Object.values(validations).map(v => v.score);
    const avgStepScore = stepScores.length > 0 ? 
      stepScores.reduce((sum, score) => sum + score, 0) / stepScores.length : 0;

    // Apply workflow-level penalties
    const workflowPenalty = (workflowErrors.length * 15) + (workflowWarnings.length * 5);
    
    return Math.max(0, Math.min(100, Math.round(avgStepScore - workflowPenalty)));
  }

  private async validateGitHistoryAnalysis(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Git history analysis result is null or undefined');
      return;
    }

    // Check required structure
    if (!result.commits || !Array.isArray(result.commits)) {
      errors.push('Missing or invalid commits array in git analysis');
    } else if (result.commits.length === 0) {
      warnings.push('No commits found in git analysis - may indicate checkpoint issue');
    }

    if (!result.architecturalDecisions || !Array.isArray(result.architecturalDecisions)) {
      errors.push('Missing architectural decisions in git analysis');
    }

    if (!result.codeEvolution || !Array.isArray(result.codeEvolution)) {
      errors.push('Missing code evolution patterns in git analysis');
    }

    if (!result.summary || typeof result.summary !== 'object') {
      errors.push('Missing or invalid summary in git analysis');
    } else {
      if (!result.summary.insights || result.summary.insights.length < 50) {
        warnings.push('Git analysis insights are too brief');
      }
    }

    // Check checkpoint information
    if (!result.checkpointInfo) {
      warnings.push('Missing checkpoint information in git analysis');
    } else if (!result.checkpointInfo.toTimestamp) {
      errors.push('Missing checkpoint timestamp in git analysis');
    }
  }

  private async validateVibeHistoryAnalysis(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Vibe history analysis result is null or undefined');
      return;
    }

    // Check required structure
    if (!result.sessions || !Array.isArray(result.sessions)) {
      errors.push('Missing or invalid sessions array in vibe analysis');
    } else if (result.sessions.length === 0) {
      warnings.push('No conversation sessions found - may indicate .specstory directory issue');
    }

    if (!result.problemSolutionPairs || !Array.isArray(result.problemSolutionPairs)) {
      errors.push('Missing problem-solution pairs in vibe analysis');
    }

    if (!result.patterns || typeof result.patterns !== 'object') {
      errors.push('Missing patterns analysis in vibe history');
    } else {
      if (!result.patterns.commonProblems || result.patterns.commonProblems.length === 0) {
        warnings.push('No common problems identified in vibe analysis');
      }
    }

    // Validate session parsing quality
    if (result.sessions) {
      const sessionsWithExchanges = result.sessions.filter((s: any) => s.exchanges && s.exchanges.length > 0);
      if (sessionsWithExchanges.length < result.sessions.length * 0.8) {
        warnings.push('Many sessions have no exchanges - may indicate parsing issues');
      }
    }
  }

  private async validateSemanticAnalysis(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Semantic analysis result is null or undefined');
      return;
    }

    // Debug logging to understand the structure
    log('Validating semantic analysis result', 'info', {
      hasInsights: 'insights' in result,
      hasSemanticInsights: 'semanticInsights' in result,
      resultKeys: Object.keys(result).filter(k => !k.startsWith('_')),
      insightsType: result.insights ? typeof result.insights : 'undefined'
    });

    // FIXED: More flexible insights validation - check multiple potential insight sources
    let insightsText = '';
    
    if (result.insights) {
      insightsText = typeof result.insights === 'string' ? result.insights : JSON.stringify(result.insights);
    } else if (result.semanticInsights?.learnings) {
      // Fallback to semantic insights learnings
      insightsText = Array.isArray(result.semanticInsights.learnings) 
        ? result.semanticInsights.learnings.join('. ')
        : String(result.semanticInsights.learnings);
      log('Using semanticInsights.learnings as fallback for insights validation', 'info', {
        learngsCount: Array.isArray(result.semanticInsights.learnings) ? result.semanticInsights.learnings.length : 1
      });
    } else if (result.semanticInsights?.keyPatterns) {
      // Another fallback to key patterns
      insightsText = Array.isArray(result.semanticInsights.keyPatterns)
        ? result.semanticInsights.keyPatterns.join(', ')
        : String(result.semanticInsights.keyPatterns);
      log('Using semanticInsights.keyPatterns as fallback for insights validation', 'info', {
        patternsCount: Array.isArray(result.semanticInsights.keyPatterns) ? result.semanticInsights.keyPatterns.length : 1
      });
    }

    // Check for meaningful insights
    if (!insightsText || insightsText.length === 0) {
      errors.push('Missing insights in semantic analysis');
    } else {
      if (insightsText.length < 100) {
        warnings.push('Semantic analysis insights are too brief');
      }
    }

    // Check for cross-analysis correlations
    if (!result.correlations && !result.patterns) {
      warnings.push('No cross-analysis correlations found - may indicate limited semantic depth');
    }
  }

  private async validateWebSearchResults(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      warnings.push('Web search results are empty - may be acceptable');
      return;
    }

    if (!result.patterns && !result.references && !result.insights) {
      warnings.push('Web search returned no actionable patterns or references');
    }

    // Check for quality of references
    if (result.references && Array.isArray(result.references)) {
      const validUrls = result.references.filter((ref: string) => 
        ref.startsWith('http') || ref.startsWith('https')
      );
      if (validUrls.length < result.references.length * 0.5) {
        warnings.push('Many web search references are not valid URLs');
      }
    }
  }

  /**
   * Use LLM to perform semantic quality validation of insight content
   */
  private async validateInsightQualityWithLLM(content: string, errors: string[], warnings: string[]): Promise<void> {
    try {
      const prompt = `You are a technical documentation quality reviewer. Analyze the following insight document and identify:

1. Conversation fragments or incomplete thoughts
2. Generic/template content that lacks specificity
3. Vague patterns without concrete evidence
4. Content that appears to be copied from chat logs
5. Overall coherence and technical value

Content to analyze:
${content.substring(0, 3000)}

Respond with a JSON object:
{
  "hasConversationFragments": boolean,
  "hasGenericContent": boolean,
  "hasVaguePatterns": boolean,
  "overallQuality": "high" | "medium" | "low",
  "specificIssues": string[],
  "confidence": number (0-1)
}`;

      const result = await this.semanticAnalyzer.analyzeContent(prompt, {
        analysisType: "general",
        provider: "auto"
      });

      // Parse LLM response
      const analysis = JSON.parse(result.insights);

      if (analysis.hasConversationFragments) {
        errors.push("LLM detected conversation fragments in insight document");
      }

      if (analysis.hasGenericContent) {
        warnings.push("LLM detected generic/template content");
      }

      if (analysis.overallQuality === "low") {
        errors.push(`LLM quality assessment: ${analysis.overallQuality} (confidence: ${analysis.confidence})`);
      }

      analysis.specificIssues.forEach((issue: string) => {
        warnings.push(`LLM issue: ${issue}`);
      });

      log("Semantic quality validation completed", "info", {
        quality: analysis.overallQuality,
        confidence: analysis.confidence
      });
    } catch (error) {
      log("Semantic quality validation failed, continuing with rule-based checks", "warning", error);
      // Don't fail QA if LLM validation fails - it's an enhancement, not a requirement
    }
  }

  private async validateInsightGeneration(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Insight generation result is null or undefined');
      return;
    }

    // CRITICAL: Validate actual content quality, not just file existence

    // ENHANCEMENT: Use LLM for semantic quality validation
    if (result.insightDocument?.content) {
      await this.validateInsightQualityWithLLM(result.insightDocument.content, errors, warnings);
    }
    
    // 1. Validate patterns are meaningful (not garbage conversation fragments)
    if (result.patternCatalog?.patterns) {
      const patterns = result.patternCatalog.patterns;
      
      // Check for garbage pattern names
      const garbagePatterns = patterns.filter((p: any) => 
        p.name.startsWith('ProblemSolutionPattern') || 
        p.name.startsWith('ArchitecturalDecision') ||
        p.name.startsWith('SemanticPattern') ||
        p.description.includes('you were just in the process') ||
        p.description.includes('I cannot see any chan') ||
        p.description.length < 20
      );
      
      if (garbagePatterns.length > 0) {
        errors.push(`Found ${garbagePatterns.length} garbage patterns with meaningless names or conversation fragments`);
        garbagePatterns.forEach((p: any) => {
          errors.push(`Garbage pattern: "${p.name}" - "${p.description.substring(0, 50)}..."`);
        });
      }
      
      // Ensure patterns have real evidence
      const patternsWithoutEvidence = patterns.filter((p: any) => 
        !p.evidence || p.evidence.length === 0 || 
        p.evidence.some((e: string) => e.includes('N/A') || e.length < 10)
      );
      
      if (patternsWithoutEvidence.length > 0) {
        errors.push(`Found ${patternsWithoutEvidence.length} patterns without meaningful evidence`);
      }
      
      if (patterns.length === 0) {
        errors.push('No patterns identified - analysis may be incomplete');
      }
    } else {
      errors.push('No pattern catalog generated');
    }

    // 2. Validate git analysis actually found commits
    if (result.gitAnalysis || result.git_analysis_results) {
      const gitData = result.gitAnalysis || result.git_analysis_results;
      if (!gitData.commits || gitData.commits.length === 0) {
        errors.push('Git analysis found 0 commits - analysis scope may be too narrow');
      } else if (gitData.commits.length < 5) {
        warnings.push(`Only ${gitData.commits.length} commits analyzed - consider broader time window`);
      }
    }

    // 3. Validate insight document content quality
    if (result.insightDocument) {
      const content = result.insightDocument.content || '';
      
      // Check for template placeholders
      if (content.includes('{{') || content.includes('}}')) {
        errors.push('Insight document contains unresolved template placeholders');
      }
      
      // Check for meaningful content length
      if (content.length < 1000) {
        errors.push('Insight document is too short to be meaningful (less than 1000 characters)');
      }
      
      // Check for conversation fragments
      const conversationFragments = [
        'you were just in the process',
        'I cannot see any chan',
        'so, it seems that you somehow',
        'User:',
        'Assistant:'
      ];
      
      const foundFragments = conversationFragments.filter(fragment => 
        content.toLowerCase().includes(fragment.toLowerCase())
      );
      
      if (foundFragments.length > 0) {
        errors.push(`Insight contains conversation fragments: ${foundFragments.join(', ')}`);
      }
    } else {
      errors.push('No insight document generated');
    }

    // 4. Validate PlantUML diagrams have real content
    if (result.insightDocument?.diagrams) {
      const diagrams = result.insightDocument.diagrams;
      const emptyDiagrams = diagrams.filter((d: any) => 
        !d.success || 
        d.content.includes('Welcome to PlantUML!') ||
        d.content.includes('@startuml\n@enduml') ||
        d.content.length < 100
      );
      
      if (emptyDiagrams.length > 0) {
        errors.push(`Found ${emptyDiagrams.length} empty or placeholder PlantUML diagrams`);
      }
      
      if (diagrams.length === 0) {
        warnings.push('No PlantUML diagrams generated');
      }
    } else {
      warnings.push('No diagrams in insight document');
    }

    // 5. Validate meaningful filename generation
    if (result.insightDocument?.name) {
      const name = result.insightDocument.name;
      if (name.includes('SemanticAnalysisInsight') || 
          name.includes('timestamp') || 
          name.match(/\d{4}-\d{2}-\d{2}/)) {
        errors.push(`Generic or timestamp-based filename: ${name}`);
      }
    }

    // 6. Final quality gate - reject if too many errors
    if (errors.length > 3) {
      errors.push('QUALITY GATE FAILED: Too many content quality issues detected - output rejected');
    }
  }

  private async validateAndCorrectObservations(
    result: any, 
    errors: string[], 
    warnings: string[]
  ): Promise<{ corrected: boolean; correctedOutput?: any }> {
    if (!result || !result.observations) {
      errors.push('Missing observations in observation generation result');
      return { corrected: false };
    }

    const observations = result.observations;
    let corrected = false;
    const correctedObservations = [];

    for (let i = 0; i < observations.length; i++) {
      const obs = observations[i];
      const correctedObs = { ...obs };
      let obsChanged = false;

      // Validate and correct entity naming
      if (!this.isValidEntityName(obs.name)) {
        const correctedName = this.correctEntityName(obs.name);
        if (correctedName !== obs.name) {
          correctedObs.name = correctedName;
          obsChanged = true;
          warnings.push(`Corrected entity name: ${obs.name} → ${correctedName}`);
        } else {
          errors.push(`Entity name '${obs.name}' violates naming conventions and cannot be auto-corrected`);
        }
      }

      // Validate significance
      if (!this.rules.significance.validRange || 
          obs.significance < this.rules.significance.validRange[0] || 
          obs.significance > this.rules.significance.validRange[1]) {
        correctedObs.significance = 5; // Default to standard significance
        obsChanged = true;
        warnings.push(`Corrected significance for ${obs.name}: ${obs.significance} → 5`);
      }

      // Validate observations structure
      if (!obs.observations || obs.observations.length < this.rules.observations.minCount) {
        errors.push(`Entity '${obs.name}' has insufficient observations (minimum: ${this.rules.observations.minCount})`);
      }

      // Check for required observation types
      const observationTypes = obs.observations
        .filter((o: any) => typeof o === 'object' && o.type)
        .map((o: any) => o.type);
      
      const missingTypes = this.rules.observations.requiredTypes.filter(
        type => !observationTypes.includes(type)
      );

      if (missingTypes.length > 0) {
        warnings.push(`Entity '${obs.name}' missing observation types: ${missingTypes.join(', ')}`);
      }

      // Ensure link observation exists
      const hasLink = obs.observations.some((o: any) => 
        (typeof o === 'string' && o.includes('localhost:8080')) ||
        (typeof o === 'object' && o.type === 'link')
      );

      if (!hasLink) {
        // Add missing link observation
        correctedObs.observations.push({
          type: 'link',
          content: `Details: knowledge-management/insights/${obs.name}.md`,
          date: new Date().toISOString()
        });
        obsChanged = true;
        warnings.push(`Added missing link observation for ${obs.name}`);
      }

      if (obsChanged) {
        corrected = true;
      }

      correctedObservations.push(correctedObs);
    }

    return {
      corrected,
      correctedOutput: corrected ? { ...result, observations: correctedObservations } : undefined
    };
  }

  private async validateKnowledgePersistence(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Knowledge persistence result is null or undefined');
      return;
    }

    // Check knowledge export file update
    const knowledgeExportPath = path.join(this.repositoryPath, '.data', 'knowledge-export', `${this.team}.json`);
    if (!fs.existsSync(knowledgeExportPath)) {
      errors.push(`Knowledge export file ${this.team}.json does not exist`);
    } else {
      try {
        const data = JSON.parse(fs.readFileSync(knowledgeExportPath, 'utf8'));
        if (!data.entities || !Array.isArray(data.entities)) {
          errors.push(`Knowledge export ${this.team}.json has invalid structure`);
        }

        if (!data.metadata || !data.metadata.last_updated) {
          warnings.push(`Knowledge export ${this.team}.json missing update timestamp`);
        }
      } catch (error) {
        errors.push(`Knowledge export ${this.team}.json is not valid JSON`);
      }
    }

    // Check for entity count increase
    if (result.entitiesCreated !== undefined && result.entitiesCreated === 0) {
      warnings.push('No new entities were created during persistence');
    }

    // Validate checkpoint updates
    if (!result.checkpointUpdated) {
      warnings.push('Analysis checkpoints may not have been updated');
    }

    // CRITICAL: Check for orphaned nodes (entities not connected to CollectiveKnowledge)
    await this.validateNoOrphanedNodes(errors, warnings);
  }

  /**
   * Validate that all entities are connected to CollectiveKnowledge
   * This prevents phantom/orphaned nodes in the knowledge graph
   */
  private async validateNoOrphanedNodes(errors: string[], warnings: string[]): Promise<void> {
    try {
      const knowledgeExportPath = path.join(this.repositoryPath, '.data', 'knowledge-export', `${this.team}.json`);

      if (!fs.existsSync(knowledgeExportPath)) {
        return; // Can't validate if file doesn't exist
      }

      const data = JSON.parse(fs.readFileSync(knowledgeExportPath, 'utf8'));
      const entities = data.entities || [];
      const relations = data.relations || [];

      // Build set of all entities that participate in relations
      const entitiesInRelations = new Set<string>();
      for (const relation of relations) {
        if (relation.from) entitiesInRelations.add(relation.from);
        if (relation.to) entitiesInRelations.add(relation.to);
        if (relation.from_name) entitiesInRelations.add(relation.from_name);
        if (relation.to_name) entitiesInRelations.add(relation.to_name);
      }

      // Project nodes and central nodes don't need to be connected
      const exemptNodes = new Set(['CollectiveKnowledge', 'Coding', 'DynArch', 'Timeline', 'Normalisa']);

      // Find orphaned entities
      const orphanedEntities: string[] = [];
      for (const entity of entities) {
        const entityName = entity.name || entity.entity_name;
        if (!entityName) continue;

        // Skip exempt nodes
        if (exemptNodes.has(entityName)) continue;
        if (entity.entityType === 'Project' || entity.entityType === 'CentralKnowledge') continue;

        // Check if entity participates in any relation
        if (!entitiesInRelations.has(entityName)) {
          orphanedEntities.push(entityName);
        }
      }

      if (orphanedEntities.length > 0) {
        errors.push(`ORPHANED NODES DETECTED: ${orphanedEntities.length} entities not connected to knowledge graph: ${orphanedEntities.slice(0, 5).join(', ')}${orphanedEntities.length > 5 ? '...' : ''}`);

        log('Orphaned nodes validation failed', 'error', {
          orphanedCount: orphanedEntities.length,
          orphanedEntities: orphanedEntities.slice(0, 10)
        });
      } else {
        log('Orphaned nodes validation passed', 'info', {
          totalEntities: entities.length,
          relationsCount: relations.length
        });
      }
    } catch (error) {
      warnings.push(`Orphaned nodes validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async validateGenericOutput(result: any, errors: string[], warnings: string[]): Promise<void> {
    if (!result) {
      errors.push('Step result is null or undefined');
      return;
    }

    if (result.error) {
      errors.push(`Step returned error: ${result.error}`);
    }

    if (result.success === false) {
      errors.push('Step did not complete successfully');
    }
  }

  private calculateQualityScores(
    result: any, 
    errors: string[], 
    warnings: string[]
  ): QualityAssuranceReport['details'] {
    // Base scores (assuming good quality)
    let structureCompliance = 100;
    let contentQuality = 100;
    let namingConventions = 100;
    let completeness = 100;

    // Deduct points for errors and warnings
    structureCompliance -= errors.length * 20; // -20 per error
    structureCompliance -= warnings.length * 5; // -5 per warning

    contentQuality -= errors.filter(e => e.includes('brief') || e.includes('missing')).length * 15;
    contentQuality -= warnings.filter(w => w.includes('quality') || w.includes('content')).length * 8;

    namingConventions -= errors.filter(e => e.includes('name') || e.includes('naming')).length * 25;
    namingConventions -= warnings.filter(w => w.includes('name') || w.includes('naming')).length * 10;

    completeness -= errors.filter(e => e.includes('missing') || e.includes('not exist')).length * 20;
    completeness -= warnings.filter(w => w.includes('missing') || w.includes('insufficient')).length * 10;

    return {
      structureCompliance: Math.max(0, structureCompliance),
      contentQuality: Math.max(0, contentQuality),
      namingConventions: Math.max(0, namingConventions),
      completeness: Math.max(0, completeness)
    };
  }

  private calculateOverallScore(
    details: QualityAssuranceReport['details'],
    errorCount: number,
    warningCount: number
  ): number {
    // Weighted average of quality scores
    const weightedScore = (
      details.structureCompliance * 0.3 +
      details.contentQuality * 0.25 +
      details.namingConventions * 0.2 +
      details.completeness * 0.25
    );

    // Additional penalty for high error/warning counts
    const penaltyScore = Math.max(0, weightedScore - (errorCount * 10) - (warningCount * 3));

    return Math.round(Math.max(0, Math.min(100, penaltyScore)));
  }

  private isValidEntityName(name: string): boolean {
    if (!name || name.length === 0) return false;
    if (name.length > this.rules.entityNaming.maxLength) return false;
    if (this.rules.entityNaming.noSpaces && name.includes(' ')) return false;
    
    // Check camelCase pattern
    if (this.rules.entityNaming.camelCase) {
      const camelCasePattern = /^[a-z][a-zA-Z0-9]*$/;
      const pascalCasePattern = /^[A-Z][a-zA-Z0-9]*$/;
      if (!camelCasePattern.test(name) && !pascalCasePattern.test(name)) {
        return false;
      }
    }
    
    return true;
  }

  private correctEntityName(name: string): string {
    if (!name) return 'UnnamedEntity';
    
    // Remove invalid characters and convert to CamelCase
    const cleaned = name
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter(word => word.length > 0)
      .slice(0, 4) // Max 4 words
      .map((word, index) => 
        index === 0 
          ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
          : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      )
      .join('');

    return cleaned || 'CorrectedEntity';
  }

  // Public method for external validation
  async validateInsightFilename(filename: string): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    
    if (!filename.endsWith('.md')) {
      issues.push('Insight filename must end with .md');
    }
    
    const nameWithoutExt = filename.replace('.md', '');
    if (!this.isValidEntityName(nameWithoutExt)) {
      issues.push('Insight filename must follow camelCase naming convention');
    }
    
    if (nameWithoutExt.length < 3) {
      issues.push('Insight filename is too short (minimum 3 characters)');
    }
    
    if (nameWithoutExt.length > 50) {
      issues.push('Insight filename is too long (maximum 50 characters)');
    }
    
    return {
      valid: issues.length === 0,
      issues
    };
  }
}