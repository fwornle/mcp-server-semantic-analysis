/**
 * Component Manifest Types
 *
 * TypeScript interfaces for the component-manifest.yaml file.
 * The manifest is the authoritative source of truth for the L1/L2 component hierarchy.
 *
 * Consumed by:
 * - Phase 5: Migration script (to create scaffold nodes)
 * - Phase 6: HierarchyClassifier (to assign entities to components)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** A single component or sub-component entry in the manifest */
export interface ComponentManifestEntry {
  /** PascalCase component name */
  name: string;
  /** Hierarchy level: 1 for Component, 2 for SubComponent */
  level: number;
  /** Human-readable description of the component's scope */
  description: string;
  /** Alternative names for this component */
  aliases: string[];
  /** Keywords used for heuristic entity classification */
  keywords: string[];
  /** L2 sub-components (empty array if none) */
  children?: ComponentManifestEntry[];
  /** True if this entry was auto-discovered by wave analysis (not hand-curated) */
  discovered?: boolean;
}

/** The project root entry */
export interface ProjectEntry {
  /** Project name (always "Coding") */
  name: string;
  /** Always 0 for project root */
  level: number;
  /** Project description */
  description: string;
}

/** Top-level manifest structure */
export interface ComponentManifest {
  /** Manifest schema version */
  version: string;
  /** Project root node */
  project: ProjectEntry;
  /** L1 component definitions */
  components: ComponentManifestEntry[];
}

/**
 * Load the component manifest from the config directory.
 * Uses the same config directory resolution as workflow-loader.ts.
 *
 * @param configDir - Optional override for config directory path
 * @returns Parsed ComponentManifest
 * @throws Error if manifest file not found
 */
export function loadComponentManifest(configDir?: string): ComponentManifest {
  const dir = configDir || path.resolve(__dirname, '../../config');
  const manifestPath = path.join(dir, 'component-manifest.yaml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Component manifest not found: ${manifestPath}`);
  }
  const content = fs.readFileSync(manifestPath, 'utf-8');
  return parse(content) as ComponentManifest;
}

/**
 * Flatten all components and sub-components into a single array.
 * Useful for iterating over all hierarchy nodes.
 *
 * @param manifest - The loaded component manifest
 * @returns Array of all entries (L1 and L2) with their hierarchy info
 */
export function flattenManifestEntries(manifest: ComponentManifest): ComponentManifestEntry[] {
  const entries: ComponentManifestEntry[] = [];
  for (const component of manifest.components) {
    entries.push(component);
    if (component.children) {
      for (const child of component.children) {
        entries.push(child);
      }
    }
  }
  return entries;
}
