/**
 * Hierarchy Classifier Agent
 *
 * Keyword-based classifier that assigns entities to components in the
 * project hierarchy using the component-manifest.yaml.
 *
 * No LLM calls — pure heuristic matching against component keywords/aliases.
 */

import { log } from '../logging.js';
import { loadComponentManifest, flattenManifestEntries, type ComponentManifest, type ComponentManifestEntry } from '../types/component-manifest.js';
import type { KGEntity } from './kg-operators.js';

export interface HierarchyClassificationResult {
  entities: KGEntity[];
  classified: number;
  unclassified: number;
  byComponent: Record<string, number>;
}

export class HierarchyClassifierAgent {
  private manifest: ComponentManifest;
  private flatEntries: ComponentManifestEntry[];
  private projectName: string;

  constructor(configDir?: string) {
    this.manifest = loadComponentManifest(configDir);
    this.flatEntries = flattenManifestEntries(this.manifest);
    this.projectName = this.manifest.project.name; // "Coding"
  }

  /**
   * Classify entities into the hierarchy based on keyword matching.
   * Sets parentId, level, and hierarchyPath on each entity.
   */
  async classifyHierarchy(params: { entities: KGEntity[] }): Promise<HierarchyClassificationResult> {
    const { entities } = params;
    const byComponent: Record<string, number> = {};
    let classified = 0;
    let unclassified = 0;

    for (const entity of entities) {
      const match = this.matchEntity(entity);
      if (match) {
        const parent = this.findParent(match);
        entity.parentId = parent ? parent.name : this.projectName;
        entity.level = 3; // All auto-classified entities are Detail level
        entity.hierarchyPath = this.buildPath(match, entity.name);

        byComponent[match.name] = (byComponent[match.name] || 0) + 1;
        classified++;
      } else {
        // Default: park under CodingPatterns as catch-all
        entity.parentId = 'CodingPatterns';
        entity.level = 3;
        entity.hierarchyPath = `${this.projectName}/CodingPatterns/${entity.name}`;

        byComponent['CodingPatterns'] = (byComponent['CodingPatterns'] || 0) + 1;
        unclassified++;
      }
    }

    log(`Hierarchy classification complete`, 'info', {
      total: entities.length,
      classified,
      unclassified,
      byComponent
    });

    return { entities, classified, unclassified, byComponent };
  }

  /**
   * Match an entity to a component by checking name + observations against
   * each component's keywords and aliases (case-insensitive).
   */
  private matchEntity(entity: KGEntity): ComponentManifestEntry | null {
    const searchText = this.buildSearchText(entity);
    let bestMatch: ComponentManifestEntry | null = null;
    let bestScore = 0;

    // Check L2 (sub-components) first — more specific matches win
    for (const entry of this.flatEntries) {
      const score = this.scoreMatch(searchText, entry);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    // Require at least 2 keyword hits to avoid false positives
    return bestScore >= 2 ? bestMatch : null;
  }

  /**
   * Build a single lowercase search string from entity name + observations.
   */
  private buildSearchText(entity: KGEntity): string {
    const parts = [entity.name];
    // Include first 5 observations to keep matching fast
    const obsSlice = entity.observations.slice(0, 5);
    for (const obs of obsSlice) {
      parts.push(typeof obs === 'string' ? obs : String(obs));
    }
    return parts.join(' ').toLowerCase();
  }

  /**
   * Score how well a search text matches a component's keywords + aliases.
   * Returns the number of distinct keyword/alias hits.
   */
  private scoreMatch(searchText: string, entry: ComponentManifestEntry): number {
    let score = 0;
    const allTerms = [...entry.keywords, ...entry.aliases, entry.name];

    for (const term of allTerms) {
      if (searchText.includes(term.toLowerCase())) {
        score++;
      }
    }

    // Bonus for L2 matches (sub-components are more specific)
    if (entry.level === 2 && score > 0) {
      score += 1;
    }

    return score;
  }

  /**
   * Find the parent component for a matched entry.
   * L2 entries → their L1 parent. L1 entries → project root.
   */
  private findParent(entry: ComponentManifestEntry): ComponentManifestEntry | null {
    if (entry.level === 1) {
      return null; // Parent is project root
    }
    // L2: find the L1 parent
    for (const component of this.manifest.components) {
      if (component.children?.some(c => c.name === entry.name)) {
        return component;
      }
    }
    return null;
  }

  /**
   * Build slash-separated hierarchy path.
   */
  private buildPath(match: ComponentManifestEntry, entityName: string): string {
    if (match.level === 2) {
      const parent = this.findParent(match);
      return `${this.projectName}/${parent?.name || 'Unknown'}/${match.name}/${entityName}`;
    }
    return `${this.projectName}/${match.name}/${entityName}`;
  }
}
