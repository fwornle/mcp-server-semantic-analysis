/**
 * OntologyClassificationAgent
 *
 * Classifies observations and entities against the ontology system.
 * Adds ontology metadata to entities before persistence.
 * Tracks unclassified patterns for auto-extension suggestions.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from '../logging.js';
import {
  OntologyConfigManager,
  ExtendedOntologyConfig,
} from '../ontology/OntologyConfigManager.js';
import { OntologyManager } from '../ontology/OntologyManager.js';
import { OntologyValidator } from '../ontology/OntologyValidator.js';
import { OntologyClassifier } from '../ontology/OntologyClassifier.js';
import { createHeuristicClassifier } from '../ontology/heuristics/index.js';
import type { OntologyClassification } from '../ontology/types.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';

/**
 * Ontology metadata to be attached to entities
 */
export interface OntologyMetadata {
  /** Matched ontology class name */
  ontologyClass: string;

  /** Ontology version */
  ontologyVersion: string;

  /** Classification confidence (0-1) */
  classificationConfidence: number;

  /** Method used for classification */
  classificationMethod: 'heuristic' | 'llm' | 'hybrid' | 'auto-assigned' | 'unclassified';

  /** Source ontology (upper or lower name) */
  ontologySource: 'upper' | 'lower';

  /** Properties extracted per ontology schema */
  properties: Record<string, any>;

  /** Timestamp of classification */
  classifiedAt: string;
}

/**
 * Observation with ontology classification
 */
export interface ClassifiedObservation {
  /** Original observation data */
  original: any;

  /** Ontology metadata */
  ontologyMetadata: OntologyMetadata;

  /** Whether classification was successful */
  classified: boolean;
}

/**
 * Result of classification process
 */
export interface ClassificationProcessResult {
  /** Successfully classified observations */
  classified: ClassifiedObservation[];

  /** Observations that couldn't be classified */
  unclassified: Array<{
    observation: any;
    reason: string;
    suggestedClass?: string;
  }>;

  /** Summary statistics */
  summary: {
    total: number;
    classifiedCount: number;
    unclassifiedCount: number;
    averageConfidence: number;
    byMethod: Record<string, number>;
    byClass: Record<string, number>;
  };

  /** Auto-extension suggestions generated */
  extensionSuggestions: Array<{
    suggestedClassName: string;
    extendsClass: string;
    matchingObservations: string[];
    confidence: number;
  }>;
}

/**
 * Agent for classifying observations against ontology
 */
export class OntologyClassificationAgent {
  private configManager: OntologyConfigManager | null = null;
  private ontologyManager: OntologyManager | null = null;
  private validator: OntologyValidator | null = null;
  private classifier: OntologyClassifier | null = null;
  private semanticAnalyzer: SemanticAnalyzer;
  private team: string;
  private basePath: string;
  private initialized: boolean = false;

  constructor(team: string = 'coding', repositoryPath?: string) {
    this.team = team;
    this.basePath = repositoryPath || process.env.KNOWLEDGE_BASE_PATH || process.cwd();
    this.semanticAnalyzer = new SemanticAnalyzer();
  }

  /**
   * Initialize the ontology system
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create default config
      const defaultConfig: ExtendedOntologyConfig = {
        enabled: true,
        upperOntologyPath: path.join(
          this.basePath,
          '.data/ontologies/upper/development-knowledge-ontology.json'
        ),
        lowerOntologyPath: path.join(
          this.basePath,
          `.data/ontologies/lower/${this.team}-ontology.json`
        ),
        team: this.team,
        validation: {
          mode: 'lenient',
          failOnError: false,
          allowUnknownProperties: true,
        },
        classification: {
          useUpper: true,
          useLower: true,
          minConfidence: 0.6,
          enableLLM: true,  // LLM enabled for semantic classification
          enableHeuristics: true,
          llmBudgetPerClassification: 500,
        },
        caching: {
          enabled: true,
          maxEntries: 100,
          ttl: 300000,
        },
        hotReload: false,
      };

      // Try to get existing config manager or create new one
      try {
        this.configManager = OntologyConfigManager.getInstance(defaultConfig);
      } catch {
        // Reset and try again (for testing scenarios)
        OntologyConfigManager.resetInstance();
        this.configManager = OntologyConfigManager.getInstance(defaultConfig);
      }

      // Initialize config manager
      await this.configManager.initialize();

      // Create ontology manager with config
      const config = this.configManager.getConfig();
      this.ontologyManager = new OntologyManager({
        enabled: config.enabled,
        upperOntologyPath: config.upperOntologyPath,
        lowerOntologyPath: config.lowerOntologyPath,
        team: config.team,
        validation: config.validation,
        classification: config.classification,
        caching: config.caching,
      });

      await this.ontologyManager.initialize();

      // Create validator and classifier
      this.validator = new OntologyValidator(this.ontologyManager);

      const heuristicClassifier = createHeuristicClassifier();

      // Create LLM inference engine using SemanticAnalyzer
      const llmInferenceEngine = {
        generateCompletion: async (prompt: string) => {
          try {
            // Get available ontology classes for context
            const availableClasses = this.ontologyManager?.getAllEntityClasses() || [];
            const classNames = availableClasses.map(c => c.name).join(', ');

            const classificationPrompt = `You are an ontology classifier. Given the following entity description, classify it into ONE of these ontology classes: ${classNames}

Entity to classify:
${prompt}

Respond with JSON only:
{
  "entityClass": "<class name from the list above>",
  "confidence": <0.0-1.0>,
  "reasoning": "<brief explanation>"
}`;

            const result = await this.semanticAnalyzer.analyzeContent(classificationPrompt, {
              maxTokens: 200,
              temperature: 0.3,  // Low temperature for consistent classification
            });

            // Parse LLM response
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              return {
                content: JSON.stringify(parsed),
                model: 'semantic-analyzer',
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              };
            }

            // Fallback if parsing fails
            return {
              content: JSON.stringify({
                entityClass: 'Unknown',
                confidence: 0.3,
                reasoning: 'LLM response parsing failed, using fallback',
              }),
              model: 'semantic-analyzer',
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            };
          } catch (error) {
            log('LLM classification failed, falling back to heuristics', 'warning', error);
            return {
              content: JSON.stringify({
                entityClass: 'Unknown',
                confidence: 0,
                reasoning: `LLM error: ${error instanceof Error ? error.message : String(error)}`,
              }),
              model: 'fallback',
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            };
          }
        },
      };

      this.classifier = new OntologyClassifier(
        this.ontologyManager,
        this.validator,
        heuristicClassifier,
        llmInferenceEngine as any
      );

      this.initialized = true;
      log('OntologyClassificationAgent initialized', 'info', { team: this.team });
    } catch (error) {
      log('Failed to initialize OntologyClassificationAgent', 'error', error);
      throw error;
    }
  }

  /**
   * Classify a batch of observations
   */
  async classifyObservations(params: {
    observations: any[];
    autoExtend?: boolean;
    minConfidence?: number;
  }): Promise<ClassificationProcessResult> {
    await this.initialize();

    const { observations = [], autoExtend = true, minConfidence = 0.6 } = params || {};

    // Handle case where observations is undefined or not an array
    const observationsList = Array.isArray(observations) ? observations : [];

    log('Classifying observations', 'info', {
      count: observationsList.length,
      autoExtend,
      minConfidence,
    });

    // If no observations, return empty result
    if (observationsList.length === 0) {
      log('No observations to classify - returning empty result', 'info');
      return {
        classified: [],
        unclassified: [],
        summary: {
          total: 0,
          classifiedCount: 0,
          unclassifiedCount: 0,
          averageConfidence: 0,
          byMethod: {},
          byClass: {},
        },
        extensionSuggestions: [],
      };
    }

    const classified: ClassifiedObservation[] = [];
    const unclassified: Array<{
      observation: any;
      reason: string;
      suggestedClass?: string;
    }> = [];

    const byMethod: Record<string, number> = {};
    const byClass: Record<string, number> = {};
    let totalConfidence = 0;

    for (const observation of observationsList) {
      try {
        const result = await this.classifySingleObservation(observation, minConfidence);

        if (result.classified) {
          classified.push(result);
          totalConfidence += result.ontologyMetadata.classificationConfidence;

          // Track statistics
          const method = result.ontologyMetadata.classificationMethod;
          byMethod[method] = (byMethod[method] || 0) + 1;

          const className = result.ontologyMetadata.ontologyClass;
          byClass[className] = (byClass[className] || 0) + 1;
        } else {
          unclassified.push({
            observation,
            reason: 'No matching ontology class found',
            suggestedClass: this.suggestClass(observation),
          });
        }
      } catch (error) {
        log('Error classifying observation', 'warning', { error, observation: observation.name });
        unclassified.push({
          observation,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Generate extension suggestions for unclassified observations
    const extensionSuggestions = autoExtend
      ? await this.generateExtensionSuggestions(unclassified)
      : [];

    const result: ClassificationProcessResult = {
      classified,
      unclassified,
      summary: {
        total: observationsList.length,
        classifiedCount: classified.length,
        unclassifiedCount: unclassified.length,
        averageConfidence: classified.length > 0 ? totalConfidence / classified.length : 0,
        byMethod,
        byClass,
      },
      extensionSuggestions,
    };

    log('Classification complete', 'info', result.summary);

    return result;
  }

  /**
   * Classify a single observation
   */
  private async classifySingleObservation(
    observation: any,
    minConfidence: number
  ): Promise<ClassifiedObservation> {
    if (!this.classifier) {
      throw new Error('Classifier not initialized');
    }

    // Build classification input from observation
    const classificationInput = this.buildClassificationInput(observation);

    // Perform classification
    const classificationResult: OntologyClassification | null = await this.classifier.classify(
      classificationInput,
      {
        team: this.team,
        minConfidence,
      }
    );

    // Handle unclassified (null result)
    if (!classificationResult) {
      const ontologyMetadata: OntologyMetadata = {
        ontologyClass: 'Unclassified',
        ontologyVersion: '1.0.0',
        classificationConfidence: 0,
        classificationMethod: 'unclassified',
        ontologySource: 'upper',
        properties: {},
        classifiedAt: new Date().toISOString(),
      };

      return {
        original: observation,
        ontologyMetadata,
        classified: false,
      };
    }

    // Build ontology metadata
    const ontologyMetadata: OntologyMetadata = {
      ontologyClass: classificationResult.entityClass,
      ontologyVersion: '1.0.0', // TODO: Get from ontology
      classificationConfidence: classificationResult.confidence,
      classificationMethod: classificationResult.method as any,
      ontologySource: classificationResult.ontology === this.team ? 'lower' : 'upper',
      properties: classificationResult.properties || {},
      classifiedAt: new Date().toISOString(),
    };

    return {
      original: observation,
      ontologyMetadata,
      classified: classificationResult.confidence >= minConfidence,
    };
  }

  /**
   * Build classification input string from observation
   */
  private buildClassificationInput(observation: any): string {
    const parts: string[] = [];

    // Add name
    if (observation.name) {
      parts.push(`Name: ${observation.name}`);
    }

    // Add entity type
    if (observation.entityType) {
      parts.push(`Type: ${observation.entityType}`);
    }

    // Add observations content
    if (observation.observations && Array.isArray(observation.observations)) {
      const obsTexts = observation.observations
        .map((o: any) => (typeof o === 'string' ? o : o.content || ''))
        .filter(Boolean)
        .slice(0, 5); // Limit to first 5

      if (obsTexts.length > 0) {
        parts.push(`Content: ${obsTexts.join('; ')}`);
      }
    }

    // Add tags
    if (observation.tags && Array.isArray(observation.tags)) {
      parts.push(`Tags: ${observation.tags.join(', ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Suggest a class for an unclassified observation
   */
  private suggestClass(observation: any): string | undefined {
    const entityType = observation.entityType?.toLowerCase() || '';
    const name = observation.name?.toLowerCase() || '';

    // Pattern matching for common types
    if (entityType.includes('pattern') || name.includes('pattern')) {
      return 'Pattern';
    }
    if (entityType.includes('insight') || name.includes('insight')) {
      return 'Insight';
    }
    if (entityType.includes('decision') || name.includes('decision')) {
      return 'Decision';
    }
    if (entityType.includes('workflow') || name.includes('workflow')) {
      return 'Workflow';
    }
    if (entityType.includes('component') || name.includes('component')) {
      return 'SystemComponent';
    }

    return undefined;
  }

  /**
   * Generate extension suggestions from unclassified observations
   */
  private async generateExtensionSuggestions(
    unclassified: Array<{ observation: any; reason: string; suggestedClass?: string }>
  ): Promise<
    Array<{
      suggestedClassName: string;
      extendsClass: string;
      matchingObservations: string[];
      confidence: number;
    }>
  > {
    // Group unclassified by suggested class
    const groups: Map<string, any[]> = new Map();

    for (const item of unclassified) {
      const suggestedClass = item.suggestedClass || item.observation.entityType || 'Unknown';
      if (!groups.has(suggestedClass)) {
        groups.set(suggestedClass, []);
      }
      groups.get(suggestedClass)!.push(item.observation);
    }

    const suggestions: Array<{
      suggestedClassName: string;
      extendsClass: string;
      matchingObservations: string[];
      confidence: number;
    }> = [];

    // Generate suggestions for groups with 2+ members
    for (const [className, observations] of groups) {
      if (observations.length >= 2 && className !== 'Unknown') {
        suggestions.push({
          suggestedClassName: className.replace(/[^a-zA-Z0-9]/g, ''),
          extendsClass: this.determineParentClass(className),
          matchingObservations: observations.map((o) => o.name || 'unnamed'),
          confidence: Math.min(0.9, 0.5 + observations.length * 0.1),
        });
      }
    }

    // Save suggestions if any
    if (suggestions.length > 0) {
      await this.saveSuggestions(suggestions);
    }

    return suggestions;
  }

  /**
   * Determine parent class for a suggested class
   */
  private determineParentClass(className: string): string {
    const lowerName = className.toLowerCase();

    if (lowerName.includes('pattern') || lowerName.includes('practice')) {
      return 'Pattern';
    }
    if (lowerName.includes('insight') || lowerName.includes('observation')) {
      return 'Insight';
    }
    if (lowerName.includes('decision') || lowerName.includes('choice')) {
      return 'Decision';
    }
    if (lowerName.includes('workflow') || lowerName.includes('process')) {
      return 'Workflow';
    }
    if (lowerName.includes('component') || lowerName.includes('module')) {
      return 'SystemComponent';
    }
    if (lowerName.includes('config') || lowerName.includes('setting')) {
      return 'ConfigurationData';
    }
    if (lowerName.includes('metric') || lowerName.includes('measure')) {
      return 'QualityMetric';
    }

    return 'Entity';
  }

  /**
   * Save extension suggestions to file
   */
  private async saveSuggestions(
    suggestions: Array<{
      suggestedClassName: string;
      extendsClass: string;
      matchingObservations: string[];
      confidence: number;
    }>
  ): Promise<void> {
    try {
      const suggestionsPath = path.join(
        this.basePath,
        '.data/ontologies/suggestions/pending-classes.json'
      );

      // Load existing
      let existing: any = { pending: [], metadata: { version: '1.0.0', lastUpdated: null } };
      try {
        const content = await fs.readFile(suggestionsPath, 'utf-8');
        existing = JSON.parse(content);
      } catch {
        // File doesn't exist yet
      }

      // Add new suggestions
      for (const suggestion of suggestions) {
        // Check if already exists
        const alreadyExists = existing.pending.some(
          (p: any) => p.suggestedClassName === suggestion.suggestedClassName
        );

        if (!alreadyExists) {
          existing.pending.push({
            id: `suggestion-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            ...suggestion,
            createdAt: new Date().toISOString(),
            status: 'pending',
          });
        }
      }

      existing.metadata.lastUpdated = new Date().toISOString();

      // Save
      await fs.mkdir(path.dirname(suggestionsPath), { recursive: true });
      await fs.writeFile(suggestionsPath, JSON.stringify(existing, null, 2));

      log('Saved extension suggestions', 'info', { count: suggestions.length });
    } catch (error) {
      log('Failed to save extension suggestions', 'warning', error);
    }
  }

  /**
   * Get classification statistics
   */
  getStatistics(): {
    initialized: boolean;
    team: string;
    ontologyLoaded: boolean;
    classesAvailable: number;
  } {
    return {
      initialized: this.initialized,
      team: this.team,
      ontologyLoaded: this.ontologyManager !== null,
      classesAvailable: this.ontologyManager?.getAllEntityClasses().length || 0,
    };
  }
}

export default OntologyClassificationAgent;
