/**
 * CgrObservationBuilder - Transforms CGR query results into tagged observations.
 *
 * Generates [CGR]-prefixed observation strings from code graph data.
 * These observations are injected into entity analysis alongside LLM-generated ones,
 * providing grounded code evidence that reduces hallucination.
 *
 * @module utils/cgr-observation-builder
 */

import type { CodeEntity } from '../agents/code-graph-agent.js';
import type { CgrEntityDetails, CgrCallGraphResult } from '../services/cgr-query-cache.js';

export class CgrObservationBuilder {
  /**
   * Build structural observations from code entities.
   * One observation per entity showing name, type, file path, and signature.
   */
  buildStructuralObservations(entities: CodeEntity[], entityName: string): string[] {
    const observations: string[] = [];

    for (const entity of entities) {
      if (!entity.name) continue;

      const fileName = entity.filePath ? entity.filePath.split('/').pop() : 'unknown';
      const sigPart = entity.signature ? ` defines ${entity.signature}` : '';
      const complexPart = entity.complexity && entity.complexity > 5 ? ` (complexity: ${entity.complexity})` : '';

      observations.push(
        `[CGR] ${entity.name} (${entity.type}) in ${fileName}${sigPart}${complexPart}`,
      );
    }

    return observations;
  }

  /**
   * Build relationship observations from callees and imports.
   * Groups relationships into meaningful observation strings.
   */
  buildRelationshipObservations(callees: string[], imports: string[]): string[] {
    const observations: string[] = [];

    if (callees.length > 0) {
      // Group callees into a single observation (up to 10)
      const displayed = callees.slice(0, 10);
      const suffix = callees.length > 10 ? ` (+${callees.length - 10} more)` : '';
      observations.push(`[CGR] Calls: ${displayed.join(', ')}${suffix}`);
    }

    if (imports.length > 0) {
      const displayed = imports.slice(0, 10);
      const suffix = imports.length > 10 ? ` (+${imports.length - 10} more)` : '';
      observations.push(`[CGR] Imports: ${displayed.join(', ')}${suffix}`);
    }

    return observations;
  }

  /**
   * Format CGR data as an XML block for LLM prompt injection.
   * Includes entity signatures, key entities, call graph, and anti-hallucination rules.
   */
  formatForLLMPrompt(details: CgrEntityDetails, callGraph?: CgrCallGraphResult): string {
    const sections: string[] = [];

    // Entity signatures
    if (details.signatures.length > 0) {
      sections.push(`<signatures>\n${details.signatures.join('\n')}\n</signatures>`);
    }

    // Top entities by complexity (up to 3)
    const topEntities = [...details.entities]
      .sort((a, b) => (b.complexity || 0) - (a.complexity || 0))
      .slice(0, 3);

    if (topEntities.length > 0) {
      const entityLines = topEntities.map(e => {
        const sig = e.signature ? `: ${e.signature}` : '';
        return `- ${e.name} (${e.type}) in ${e.filePath?.split('/').pop() || 'unknown'}${sig}`;
      });
      sections.push(`<key_entities>\n${entityLines.join('\n')}\n</key_entities>`);
    }

    // Call graph chains
    if (callGraph && callGraph.chains.length > 0) {
      const chainLines = callGraph.chains.slice(0, 15).map(c => `- ${c.caller} -> ${c.callee}`);
      sections.push(`<call_graph depth="${callGraph.depth}">\n${chainLines.join('\n')}\n</call_graph>`);
    }

    // Imports
    if (details.imports.length > 0) {
      sections.push(`<imports>\n${details.imports.join('\n')}\n</imports>`);
    }

    // Anti-hallucination rules
    const rules = [
      'Only reference functions/classes that appear in <code_graph>.',
      'Do NOT invent file paths or function names not present in the code graph data.',
      'Prefix observations grounded in code graph data with [LLM+CGR].',
      'Prefix observations from your own analysis with [LLM].',
    ].join('\n');

    return `<code_graph>\n${sections.join('\n\n')}\n\n<rules>\n${rules}\n</rules>\n</code_graph>`;
  }

  /**
   * Check whether CGR returned any evidence for an entity.
   * Used to set the _noCgrEvidence flag on EnrichedEntity.
   */
  hasEvidence(entities: CodeEntity[]): boolean {
    return entities.length > 0;
  }
}
