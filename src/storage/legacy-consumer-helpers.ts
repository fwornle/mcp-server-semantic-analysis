/**
 * Legacy consumer helpers — Phase 42.2 Plan 04.
 *
 * Free functions that port the non-graph methods previously hung off
 * `PersistenceAgent` and `GraphDatabaseAdapter`. These methods touch
 * the filesystem (insight markdown / PUML / PNG files, JSON exports,
 * workflow-completion markers) but do not require km-core graph access
 * beyond the read primitives already exposed on `KmCoreAdapter`.
 *
 * The trio of legacy modules (persistence-agent.ts,
 * graph-database-adapter.ts, GraphDatabaseService.js) was retired in
 * this plan. coordinator.ts / tools.ts / content-validation-agent.ts
 * now call these helpers + the km-core adapter directly.
 *
 * Logging: process.stderr.write only (CLAUDE.md no-console-log).
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import type { KmCoreAdapter } from './km-core-adapter.js';

// ---------------------------------------------------------------------------
// saveSuccessfulWorkflowCompletion
// ---------------------------------------------------------------------------

/**
 * Port of `PersistenceAgent.saveSuccessfulWorkflowCompletion(...)`.
 *
 * The legacy implementation updated `sharedMemory.metadata` (a JSON file at
 * `.data/knowledge-graph/shared-memory.json`). With the trio gone, we
 * persist the marker to `.data/workflow-completion-log.json` instead —
 * a small, append-friendly operator artifact that records the most recent
 * successful completion + a running count.
 *
 * No km-core mutation; metadata is operator-facing, not part of the canonical
 * entity graph.
 */
export async function saveSuccessfulWorkflowCompletion(
  repositoryPath: string,
  workflowName: string,
  timestamp: Date = new Date(),
): Promise<{
  success: boolean;
  checkpointUpdated: boolean;
  errors: string[];
  summary: string;
}> {
  const result = {
    success: false,
    checkpointUpdated: false,
    errors: [] as string[],
    summary: '',
  };

  try {
    const logPath = path.join(repositoryPath, '.data', 'workflow-completion-log.json');
    const dirPath = path.dirname(logPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    let existing: {
      lastSuccessfulWorkflowCompletion?: string;
      lastCompletedWorkflow?: string;
      successfulWorkflowCount?: number;
      last_updated?: string;
    } = {};
    if (fs.existsSync(logPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      } catch {
        // Corrupt file — overwrite cleanly
        existing = {};
      }
    }

    const updated = {
      lastSuccessfulWorkflowCompletion: timestamp.toISOString(),
      lastCompletedWorkflow: workflowName,
      successfulWorkflowCount: (existing.successfulWorkflowCount ?? 0) + 1,
      last_updated: timestamp.toISOString(),
    };

    fs.writeFileSync(logPath, JSON.stringify(updated, null, 2));
    result.checkpointUpdated = true;
    result.success = true;
    result.summary = `Successful workflow completion recorded: ${workflowName}`;
    return result;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    result.summary = `Workflow completion checkpoint failed: ${result.errors[0]}`;
    return result;
  }
}

// ---------------------------------------------------------------------------
// linkInsightDocuments
// ---------------------------------------------------------------------------

/**
 * Port of `PersistenceAgent.linkInsightDocuments(...)`.
 *
 * Scans an insight directory for `<EntityName>.md` files, looks up each
 * entity via the km-core adapter, and stamps `metadata.validated_file_path`
 * + `metadata.has_insight_document = true` on matched entities via
 * `mergeAttributes`. Returns counts + the file list.
 */
export async function linkInsightDocuments(
  adapter: KmCoreAdapter,
  params: { team: string; insightDir: string },
): Promise<{
  linked: number;
  notFound: number;
  files: string[];
}> {
  const result = { linked: 0, notFound: 0, files: [] as string[] };

  if (!fs.existsSync(params.insightDir)) {
    process.stderr.write(
      `[legacy-consumer-helpers.linkInsightDocuments] Insight directory not found: ${params.insightDir}\n`,
    );
    return result;
  }

  const files = fs.readdirSync(params.insightDir).filter((f) => f.endsWith('.md'));
  result.files = files;

  for (const file of files) {
    const entityName = file.replace(/\.md$/, '');
    const filePath = path.join(params.insightDir, file);

    try {
      const existing = await adapter.getEntity(entityName, params.team);
      if (existing) {
        const oldMetadata = (existing.metadata ?? {}) as Record<string, unknown>;
        await adapter.mergeAttributes(`${params.team}:${entityName}`, {
          metadata: {
            ...oldMetadata,
            has_insight_document: true,
            validated_file_path: filePath,
            last_updated: new Date().toISOString(),
          },
        });
        result.linked++;
      } else {
        result.notFound++;
      }
    } catch (err) {
      process.stderr.write(
        `[legacy-consumer-helpers.linkInsightDocuments] Failed to link insight for ${entityName}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      result.notFound++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// cleanupEntityFiles
// ---------------------------------------------------------------------------

/**
 * Port of `PersistenceAgent.cleanupEntityFiles(...)`.
 *
 * Filesystem-only — removes entity-named insight markdown, PUML, and PNG
 * files. When `cleanOrphans` is true, queries the adapter for all entities
 * and removes any file whose name doesn't match a live entity (skipping
 * underscore-prefixed style files + README).
 */
export async function cleanupEntityFiles(
  adapter: KmCoreAdapter,
  insightsDir: string,
  params: { entityName?: string; team: string; cleanOrphans?: boolean },
): Promise<{
  deletedFiles: string[];
  errors: string[];
}> {
  const result = { deletedFiles: [] as string[], errors: [] as string[] };
  const pumlDir = path.join(insightsDir, 'puml');
  const imagesDir = path.join(insightsDir, 'images');

  const toKebabCase = (s: string): string =>
    s
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[\s_]+/g, '-')
      .toLowerCase();

  try {
    if (params.entityName) {
      const kebabName = toKebabCase(params.entityName);
      const filesToCheck: string[] = [
        path.join(insightsDir, `${params.entityName}.md`),
      ];

      if (fs.existsSync(pumlDir)) {
        const pumlFiles = fs
          .readdirSync(pumlDir)
          .filter((f) => f.startsWith(`${kebabName}-`))
          .map((f) => path.join(pumlDir, f));
        filesToCheck.push(...pumlFiles);
      }
      if (fs.existsSync(imagesDir)) {
        const pngFiles = fs
          .readdirSync(imagesDir)
          .filter((f) => f.startsWith(`${kebabName}-`))
          .map((f) => path.join(imagesDir, f));
        filesToCheck.push(...pngFiles);
      }

      for (const file of filesToCheck) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          result.deletedFiles.push(file);
        }
      }
    }

    if (params.cleanOrphans) {
      const allEntities = await adapter.queryEntities();
      const entityNames = new Set(allEntities.map((e) => e.name));
      const entityKebabNames = new Set(allEntities.map((e) => toKebabCase(e.name)));

      // Insight markdown files
      if (fs.existsSync(insightsDir)) {
        const insightFiles = fs
          .readdirSync(insightsDir)
          .filter((f) => f.endsWith('.md'));
        for (const file of insightFiles) {
          const entityName = file.replace('.md', '');
          if (
            !entityNames.has(entityName) &&
            entityName !== 'README' &&
            !file.startsWith('_')
          ) {
            const filePath = path.join(insightsDir, file);
            fs.unlinkSync(filePath);
            result.deletedFiles.push(filePath);
          }
        }
      }

      // PUML orphans (progressive prefix match)
      if (fs.existsSync(pumlDir)) {
        const pumlFiles = fs
          .readdirSync(pumlDir)
          .filter((f) => f.endsWith('.puml'));
        for (const file of pumlFiles) {
          if (file.startsWith('_')) continue;
          const parts = file.replace('.puml', '').split('-');
          let matched = false;
          for (let i = parts.length - 1; i > 0; i--) {
            const prefix = parts.slice(0, i).join('-');
            if (entityKebabNames.has(prefix)) {
              matched = true;
              break;
            }
          }
          if (!matched) {
            const filePath = path.join(pumlDir, file);
            fs.unlinkSync(filePath);
            result.deletedFiles.push(filePath);
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

// ---------------------------------------------------------------------------
// exportKnowledgeToJSON
// ---------------------------------------------------------------------------

/**
 * Port of `GraphDatabaseAdapter.exportToJSON(exportPath)`.
 *
 * Writes a `{ entities: [], relations: [], metadata: { team, exportedAt } }`
 * JSON snapshot of the current km-core store at `exportPath`. Used by
 * coordinator.ts at the end of a successful workflow to give operator
 * tooling a git-trackable view of the knowledge graph.
 */
export async function exportKnowledgeToJSON(
  adapter: KmCoreAdapter,
  exportPath: string,
  team: string,
): Promise<{ entitiesExported: number; relationsExported: number; path: string }> {
  const dirPath = path.dirname(exportPath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const entities = await adapter.queryEntities();

  const snapshot = {
    entities,
    relations: [] as unknown[], // km-core relations are not part of this snapshot path — caller may extend
    metadata: {
      team,
      exportedAt: new Date().toISOString(),
      source: 'km-core-adapter',
      phase: '42.2-04',
    },
  };

  await fsPromises.writeFile(exportPath, JSON.stringify(snapshot, null, 2));

  return {
    entitiesExported: entities.length,
    relationsExported: snapshot.relations.length,
    path: exportPath,
  };
}
