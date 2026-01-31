/**
 * LLM Mock Service
 *
 * Provides mock LLM responses for testing frontend logic without actual API calls.
 * Each mock generates plausible data that maintains workflow continuity.
 */

import * as fs from 'fs';
import * as path from 'path';

// Mock configuration stored in progress file
export interface MockLLMConfig {
  enabled: boolean;
  updatedAt?: string;
  mockDelay?: number;  // Simulated delay in ms (default: 500)
}

// Standard LLM response structure
export interface MockLLMResponse {
  content: string;
  provider: string;
  model: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

// Embedding response structure
export interface MockEmbeddingResponse {
  embedding: number[];
  provider: string;
  model: string;
  tokenUsage: {
    inputTokens: number;
    totalTokens: number;
  };
}

/**
 * Check if LLM mock mode is enabled by reading the progress file
 */
export function isMockLLMEnabled(repositoryPath: string): boolean {
  try {
    const progressPath = path.join(repositoryPath, '.data', 'workflow-progress.json');
    if (!fs.existsSync(progressPath)) return false;

    const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    return progress.mockLLM === true;
  } catch {
    return false;
  }
}

/**
 * Get mock delay from config (uses orchestrator.yaml default, overridable via progress file)
 */
export function getMockDelay(repositoryPath: string): number {
  // Default from orchestrator.yaml mock_mode.default_llm_delay_ms (250ms)
  const DEFAULT_MOCK_DELAY = 250;

  try {
    // Check if progress file has an override
    const progressPath = path.join(repositoryPath, '.data', 'workflow-progress.json');
    if (fs.existsSync(progressPath)) {
      const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      if (progress.mockLLMDelay !== undefined && progress.mockLLMDelay !== null) {
        return progress.mockLLMDelay;
      }
    }
    return DEFAULT_MOCK_DELAY;
  } catch {
    return DEFAULT_MOCK_DELAY;
  }
}

/**
 * Simulate async delay for realistic testing
 */
async function simulateDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// MOCK RESPONSE GENERATORS
// Each generator creates plausible data for its agent type
// ============================================================================

/**
 * Generate mock semantic analysis response
 * Used by: semantic-analyzer.ts, semantic-analysis-agent.ts
 */
export async function mockSemanticAnalysis(
  prompt: string,
  repositoryPath: string
): Promise<MockLLMResponse> {
  const delay = getMockDelay(repositoryPath);
  await simulateDelay(delay);

  // Extract context from prompt to generate relevant mock
  const isCode = prompt.includes('function') || prompt.includes('class') || prompt.includes('import');
  const isGit = prompt.includes('commit') || prompt.includes('diff');
  const isVibe = prompt.includes('session') || prompt.includes('conversation');

  let mockContent: string;

  if (isGit) {
    mockContent = JSON.stringify({
      summary: "Mock: Code modifications detected in core modules",
      patterns: [
        { type: "refactoring", confidence: 0.85, description: "Function extraction pattern" },
        { type: "feature_addition", confidence: 0.78, description: "New API endpoint added" }
      ],
      entities: [
        { name: "MockPattern_CodeRefactoring", type: "Pattern", significance: 7 },
        { name: "MockInsight_APIDesign", type: "Insight", significance: 8 }
      ],
      observations: [
        "Code follows established patterns",
        "Test coverage maintained",
        "Documentation updated"
      ]
    }, null, 2);
  } else if (isVibe) {
    mockContent = JSON.stringify({
      summary: "Mock: Development session analyzed",
      decisions: [
        { decision: "Adopted MVI architecture", rationale: "Better state management", confidence: 0.9 },
        { decision: "Used Redux for global state", rationale: "Predictable state updates", confidence: 0.85 }
      ],
      learnings: [
        { topic: "State Management", insight: "MVI reduces state bugs", significance: 8 },
        { topic: "Testing", insight: "Mock services improve test reliability", significance: 7 }
      ],
      entities: [
        { name: "MockWorkflow_MVIPattern", type: "Workflow", significance: 8 }
      ]
    }, null, 2);
  } else if (isCode) {
    mockContent = JSON.stringify({
      summary: "Mock: Code structure analyzed",
      codePatterns: [
        { pattern: "Singleton", location: "src/services", confidence: 0.92 },
        { pattern: "Factory", location: "src/factories", confidence: 0.88 }
      ],
      dependencies: [
        { from: "ServiceA", to: "ServiceB", type: "dependency" },
        { from: "Controller", to: "ServiceA", type: "uses" }
      ],
      entities: [
        { name: "MockClass_ServicePattern", type: "Pattern", significance: 6 }
      ]
    }, null, 2);
  } else {
    mockContent = JSON.stringify({
      summary: "Mock: General analysis completed",
      findings: [
        "Codebase follows best practices",
        "Architecture is well-structured",
        "Tests are comprehensive"
      ],
      entities: [
        { name: "MockEntity_GeneralInsight", type: "Insight", significance: 5 }
      ],
      confidence: 0.8
    }, null, 2);
  }

  return {
    content: mockContent,
    provider: "mock",
    model: "mock-llm-v1",
    tokenUsage: {
      inputTokens: Math.floor(prompt.length / 4),
      outputTokens: Math.floor(mockContent.length / 4),
      totalTokens: Math.floor((prompt.length + mockContent.length) / 4)
    }
  };
}

/**
 * Generate mock observation response
 * Used by: observation-generation-agent.ts
 */
export async function mockObservationGeneration(
  prompt: string,
  repositoryPath: string
): Promise<MockLLMResponse> {
  const delay = getMockDelay(repositoryPath);
  await simulateDelay(delay);

  const mockContent = JSON.stringify({
    observations: [
      {
        id: `mock_obs_${Date.now()}_1`,
        type: "code_quality",
        content: "Mock: Code maintains consistent style and formatting",
        confidence: 0.85,
        sources: ["src/components/", "src/services/"]
      },
      {
        id: `mock_obs_${Date.now()}_2`,
        type: "architecture",
        content: "Mock: Layer separation is well-maintained",
        confidence: 0.88,
        sources: ["src/store/", "src/api/"]
      },
      {
        id: `mock_obs_${Date.now()}_3`,
        type: "testing",
        content: "Mock: Test coverage is adequate for critical paths",
        confidence: 0.82,
        sources: ["tests/", "src/__tests__/"]
      }
    ],
    summary: "Mock observations generated for testing",
    totalObservations: 3
  }, null, 2);

  return {
    content: mockContent,
    provider: "mock",
    model: "mock-llm-v1",
    tokenUsage: {
      inputTokens: Math.floor(prompt.length / 4),
      outputTokens: Math.floor(mockContent.length / 4),
      totalTokens: Math.floor((prompt.length + mockContent.length) / 4)
    }
  };
}

/**
 * Generate mock insight response
 * Used by: insight-generation-agent.ts
 */
export async function mockInsightGeneration(
  prompt: string,
  repositoryPath: string
): Promise<MockLLMResponse> {
  const delay = getMockDelay(repositoryPath);
  await simulateDelay(delay);

  const timestamp = new Date().toISOString();
  const mockContent = JSON.stringify({
    insights: [
      {
        id: `mock_insight_${Date.now()}_1`,
        title: "MockInsight: Architecture Pattern",
        content: "The codebase demonstrates consistent use of the MVI architecture pattern for state management.",
        type: "Pattern",
        significance: 8,
        confidence: 0.87,
        relatedEntities: ["StateManager", "ViewModel", "Intent"],
        createdAt: timestamp
      },
      {
        id: `mock_insight_${Date.now()}_2`,
        title: "MockInsight: Testing Strategy",
        content: "Unit tests follow the AAA pattern (Arrange-Act-Assert) consistently.",
        type: "Workflow",
        significance: 7,
        confidence: 0.85,
        relatedEntities: ["TestRunner", "MockService"],
        createdAt: timestamp
      }
    ],
    summary: "Mock insights generated for frontend testing",
    totalInsights: 2
  }, null, 2);

  return {
    content: mockContent,
    provider: "mock",
    model: "mock-llm-v1",
    tokenUsage: {
      inputTokens: Math.floor(prompt.length / 4),
      outputTokens: Math.floor(mockContent.length / 4),
      totalTokens: Math.floor((prompt.length + mockContent.length) / 4)
    }
  };
}

/**
 * Generate mock ontology classification response
 * Used by: ontology-classification-agent.ts
 */
export async function mockOntologyClassification(
  prompt: string,
  repositoryPath: string
): Promise<MockLLMResponse> {
  const delay = getMockDelay(repositoryPath);
  await simulateDelay(delay);

  const mockContent = JSON.stringify({
    classifications: [
      {
        entityName: "MockEntity_Pattern",
        ontologyClass: "DesignPattern",
        confidence: 0.9,
        properties: {
          category: "Structural",
          applicability: "High",
          complexity: "Medium"
        }
      },
      {
        entityName: "MockEntity_Workflow",
        ontologyClass: "DevelopmentWorkflow",
        confidence: 0.88,
        properties: {
          phase: "Implementation",
          automation: "Partial"
        }
      }
    ],
    unmatchedEntities: [],
    suggestedNewClasses: [],
    summary: "Mock classification completed"
  }, null, 2);

  return {
    content: mockContent,
    provider: "mock",
    model: "mock-llm-v1",
    tokenUsage: {
      inputTokens: Math.floor(prompt.length / 4),
      outputTokens: Math.floor(mockContent.length / 4),
      totalTokens: Math.floor((prompt.length + mockContent.length) / 4)
    }
  };
}

/**
 * Generate mock quality assurance response
 * Used by: quality-assurance-agent.ts
 */
export async function mockQualityAssurance(
  prompt: string,
  repositoryPath: string
): Promise<MockLLMResponse> {
  const delay = getMockDelay(repositoryPath);
  await simulateDelay(delay);

  const mockContent = JSON.stringify({
    qaResults: {
      passed: true,
      score: 0.92,
      checks: [
        { name: "entity_completeness", passed: true, score: 0.95 },
        { name: "relationship_validity", passed: true, score: 0.90 },
        { name: "content_quality", passed: true, score: 0.88 },
        { name: "duplicate_detection", passed: true, score: 0.94 }
      ]
    },
    issues: [],
    recommendations: [
      "Mock: All quality checks passed"
    ],
    summary: "Mock QA completed successfully"
  }, null, 2);

  return {
    content: mockContent,
    provider: "mock",
    model: "mock-llm-v1",
    tokenUsage: {
      inputTokens: Math.floor(prompt.length / 4),
      outputTokens: Math.floor(mockContent.length / 4),
      totalTokens: Math.floor((prompt.length + mockContent.length) / 4)
    }
  };
}

/**
 * Generate mock deduplication LLM response
 * Used by: deduplication.ts (for LLM-based similarity)
 */
export async function mockDeduplicationAnalysis(
  prompt: string,
  repositoryPath: string
): Promise<MockLLMResponse> {
  const delay = getMockDelay(repositoryPath);
  await simulateDelay(delay);

  const mockContent = JSON.stringify({
    duplicateGroups: [],
    mergeRecommendations: [],
    uniqueEntities: 10,
    deduplicatedCount: 0,
    summary: "Mock: No duplicates found in this batch"
  }, null, 2);

  return {
    content: mockContent,
    provider: "mock",
    model: "mock-llm-v1",
    tokenUsage: {
      inputTokens: Math.floor(prompt.length / 4),
      outputTokens: Math.floor(mockContent.length / 4),
      totalTokens: Math.floor((prompt.length + mockContent.length) / 4)
    }
  };
}

/**
 * Generate mock staleness detection LLM response
 * Used by: git-staleness-detector.ts
 */
export async function mockStalenessDetection(
  prompt: string,
  repositoryPath: string
): Promise<MockLLMResponse> {
  const delay = getMockDelay(repositoryPath);
  await simulateDelay(delay);

  const mockContent = JSON.stringify({
    staleEntities: [],
    validEntities: ["MockEntity_1", "MockEntity_2"],
    confidence: 0.95,
    summary: "Mock: All entities are current"
  }, null, 2);

  return {
    content: mockContent,
    provider: "mock",
    model: "mock-llm-v1",
    tokenUsage: {
      inputTokens: Math.floor(prompt.length / 4),
      outputTokens: Math.floor(mockContent.length / 4),
      totalTokens: Math.floor((prompt.length + mockContent.length) / 4)
    }
  };
}

/**
 * Generate mock content validation response
 * Used by: content-validation-agent.ts
 */
export async function mockContentValidation(
  prompt: string,
  repositoryPath: string
): Promise<MockLLMResponse> {
  const delay = getMockDelay(repositoryPath);
  await simulateDelay(delay);

  const mockContent = JSON.stringify({
    validationResult: {
      isValid: true,
      score: 0.94,
      checks: {
        format: { passed: true, score: 0.96 },
        content: { passed: true, score: 0.92 },
        references: { passed: true, score: 0.94 }
      }
    },
    issues: [],
    summary: "Mock: Content validation passed"
  }, null, 2);

  return {
    content: mockContent,
    provider: "mock",
    model: "mock-llm-v1",
    tokenUsage: {
      inputTokens: Math.floor(prompt.length / 4),
      outputTokens: Math.floor(mockContent.length / 4),
      totalTokens: Math.floor((prompt.length + mockContent.length) / 4)
    }
  };
}

/**
 * Generate mock embedding vector
 * Used by: deduplication.ts, git-staleness-detector.ts
 */
export async function mockEmbedding(
  text: string,
  repositoryPath: string
): Promise<MockEmbeddingResponse> {
  const delay = getMockDelay(repositoryPath);
  await simulateDelay(delay / 2);  // Embeddings are usually faster

  // Generate a deterministic but pseudo-random embedding based on text hash
  const hash = simpleHash(text);
  const dimensions = 1536;  // Same as text-embedding-3-small
  const embedding: number[] = [];

  for (let i = 0; i < dimensions; i++) {
    // Generate pseudo-random values between -1 and 1
    const seed = (hash + i * 31) % 100000;
    embedding.push((Math.sin(seed) + Math.cos(seed * 0.7)) / 2);
  }

  // Normalize the embedding
  const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  const normalizedEmbedding = embedding.map(v => v / magnitude);

  return {
    embedding: normalizedEmbedding,
    provider: "mock",
    model: "mock-embedding-v1",
    tokenUsage: {
      inputTokens: Math.floor(text.length / 4),
      totalTokens: Math.floor(text.length / 4)
    }
  };
}

/**
 * Simple hash function for deterministic mock data
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

/**
 * Generic mock LLM call wrapper
 * Determines the appropriate mock based on context/agent type
 */
export async function mockLLMCall(
  agentType: 'semantic' | 'observation' | 'insight' | 'ontology' | 'qa' | 'dedup' | 'staleness' | 'validation' | 'generic',
  prompt: string,
  repositoryPath: string
): Promise<MockLLMResponse> {
  switch (agentType) {
    case 'semantic':
      return mockSemanticAnalysis(prompt, repositoryPath);
    case 'observation':
      return mockObservationGeneration(prompt, repositoryPath);
    case 'insight':
      return mockInsightGeneration(prompt, repositoryPath);
    case 'ontology':
      return mockOntologyClassification(prompt, repositoryPath);
    case 'qa':
      return mockQualityAssurance(prompt, repositoryPath);
    case 'dedup':
      return mockDeduplicationAnalysis(prompt, repositoryPath);
    case 'staleness':
      return mockStalenessDetection(prompt, repositoryPath);
    case 'validation':
      return mockContentValidation(prompt, repositoryPath);
    default:
      return mockSemanticAnalysis(prompt, repositoryPath);
  }
}

// Export for use in agents
export default {
  isMockLLMEnabled,
  getMockDelay,
  mockLLMCall,
  mockEmbedding,
  mockSemanticAnalysis,
  mockObservationGeneration,
  mockInsightGeneration,
  mockOntologyClassification,
  mockQualityAssurance,
  mockDeduplicationAnalysis,
  mockStalenessDetection,
  mockContentValidation
};
