/**
 * EmbeddingCache
 *
 * Disk-backed cache for entity embeddings with TTL and content-hash invalidation.
 * Embeddings are expensive to generate, so this cache persists across process restarts.
 *
 * Features:
 * - Disk persistence at `.data/entity-embeddings.json`
 * - 7-day TTL (configurable)
 * - Content hash-based invalidation
 * - Debounced writes to avoid excessive disk I/O
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { log } from "../logging.js";

export interface CachedEmbedding {
  embedding: number[];
  contentHash: string;
  cachedAt: number;
  entityName: string;
  entityType?: string;
}

export interface EmbeddingCacheConfig {
  cachePath?: string;           // Default: `.data/entity-embeddings.json`
  ttlMs?: number;               // Default: 7 days
  writeDebounceMs?: number;     // Default: 5000ms
  maxEntries?: number;          // Default: 10000
}

interface CacheData {
  version: number;
  entries: Record<string, CachedEmbedding>;
  metadata: {
    lastUpdated: string;
    totalEntries: number;
    averageEmbeddingSize: number;
  };
}

export class EmbeddingCache {
  private cache: Map<string, CachedEmbedding> = new Map();
  private cachePath: string;
  private ttlMs: number;
  private writeDebounceMs: number;
  private maxEntries: number;
  private writeTimeout: NodeJS.Timeout | null = null;
  private isDirty: boolean = false;
  private isInitialized: boolean = false;

  constructor(config?: EmbeddingCacheConfig) {
    const defaultDataDir = process.env.DATA_DIR || path.join(process.cwd(), ".data");
    this.cachePath = config?.cachePath || path.join(defaultDataDir, "entity-embeddings.json");
    this.ttlMs = config?.ttlMs || 7 * 24 * 60 * 60 * 1000; // 7 days
    this.writeDebounceMs = config?.writeDebounceMs || 5000;
    this.maxEntries = config?.maxEntries || 10000;
  }

  /**
   * Initialize the cache by loading from disk
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      await this.loadFromDisk();
      this.isInitialized = true;
      log("EmbeddingCache initialized", "info", {
        cachePath: this.cachePath,
        entriesLoaded: this.cache.size,
        ttlDays: this.ttlMs / (24 * 60 * 60 * 1000)
      });
    } catch (error) {
      // Log error but don't fail - cache can be rebuilt
      log("Failed to load embedding cache from disk, starting fresh", "warning", { error });
      this.cache = new Map();
      this.isInitialized = true;
    }
  }

  /**
   * Get a cached embedding if valid (not expired, content matches)
   */
  get(entityName: string, contentHash: string): number[] | null {
    const cached = this.cache.get(entityName);
    if (!cached) {
      return null;
    }

    // Check content hash
    if (cached.contentHash !== contentHash) {
      return null;
    }

    // Check TTL
    const age = Date.now() - cached.cachedAt;
    if (age > this.ttlMs) {
      return null;
    }

    return cached.embedding;
  }

  /**
   * Store an embedding in the cache
   */
  set(entityName: string, embedding: number[], contentHash: string, entityType?: string): void {
    const entry: CachedEmbedding = {
      embedding,
      contentHash,
      cachedAt: Date.now(),
      entityName,
      entityType
    };

    this.cache.set(entityName, entry);
    this.isDirty = true;
    this.scheduleDiskWrite();

    // Enforce max entries limit
    if (this.cache.size > this.maxEntries) {
      this.evictOldestEntries();
    }
  }

  /**
   * Remove a specific entry from the cache
   */
  remove(entityName: string): boolean {
    const removed = this.cache.delete(entityName);
    if (removed) {
      this.isDirty = true;
      this.scheduleDiskWrite();
    }
    return removed;
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    this.cache.clear();
    this.isDirty = true;
    this.scheduleDiskWrite();
  }

  /**
   * Generate a content hash for embedding cache validation
   */
  static hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").substring(0, 16);
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    totalEntries: number;
    expiredEntries: number;
    averageAge: number;
    cacheHitRate: number;
  } {
    const now = Date.now();
    let expiredCount = 0;
    let totalAge = 0;

    for (const entry of this.cache.values()) {
      const age = now - entry.cachedAt;
      totalAge += age;
      if (age > this.ttlMs) {
        expiredCount++;
      }
    }

    return {
      totalEntries: this.cache.size,
      expiredEntries: expiredCount,
      averageAge: this.cache.size > 0 ? totalAge / this.cache.size : 0,
      cacheHitRate: 0 // Would need to track hits/misses for this
    };
  }

  /**
   * Remove expired entries from the cache
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.cachedAt;
      if (age > this.ttlMs) {
        this.cache.delete(key);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.isDirty = true;
      this.scheduleDiskWrite();
      log(`Pruned ${pruned} expired embedding cache entries`, "info");
    }

    return pruned;
  }

  /**
   * Force an immediate write to disk
   */
  async flush(): Promise<void> {
    if (this.writeTimeout) {
      clearTimeout(this.writeTimeout);
      this.writeTimeout = null;
    }

    if (this.isDirty) {
      await this.writeToDisk();
    }
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private async loadFromDisk(): Promise<void> {
    if (!fs.existsSync(this.cachePath)) {
      log("No existing embedding cache file found", "debug", { cachePath: this.cachePath });
      return;
    }

    const content = await fs.promises.readFile(this.cachePath, "utf-8");
    const data: CacheData = JSON.parse(content);

    // Version check for future compatibility
    if (data.version !== 1) {
      log("Incompatible cache version, starting fresh", "warning", { version: data.version });
      return;
    }

    // Load entries
    for (const [key, entry] of Object.entries(data.entries)) {
      this.cache.set(key, entry);
    }

    log("Embedding cache loaded from disk", "debug", {
      entries: this.cache.size,
      lastUpdated: data.metadata.lastUpdated
    });
  }

  private async writeToDisk(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }

      // Calculate average embedding size
      let totalSize = 0;
      const entries: Record<string, CachedEmbedding> = {};

      for (const [key, entry] of this.cache.entries()) {
        entries[key] = entry;
        totalSize += entry.embedding.length;
      }

      const data: CacheData = {
        version: 1,
        entries,
        metadata: {
          lastUpdated: new Date().toISOString(),
          totalEntries: this.cache.size,
          averageEmbeddingSize: this.cache.size > 0 ? totalSize / this.cache.size : 0
        }
      };

      await fs.promises.writeFile(this.cachePath, JSON.stringify(data, null, 2));
      this.isDirty = false;

      log("Embedding cache written to disk", "debug", {
        entries: this.cache.size,
        path: this.cachePath
      });
    } catch (error) {
      log("Failed to write embedding cache to disk", "error", { error });
    }
  }

  private scheduleDiskWrite(): void {
    if (this.writeTimeout) {
      return; // Already scheduled
    }

    this.writeTimeout = setTimeout(async () => {
      this.writeTimeout = null;
      if (this.isDirty) {
        await this.writeToDisk();
      }
    }, this.writeDebounceMs);
  }

  private evictOldestEntries(): void {
    // Convert to array and sort by age (oldest first)
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].cachedAt - b[1].cachedAt);

    // Remove oldest 10% of entries
    const toRemove = Math.floor(this.maxEntries * 0.1);
    for (let i = 0; i < toRemove && entries[i]; i++) {
      this.cache.delete(entries[i][0]);
    }

    log(`Evicted ${toRemove} oldest embedding cache entries`, "info", {
      remaining: this.cache.size
    });
  }
}

// Export singleton instance for shared use
let sharedCache: EmbeddingCache | null = null;

export function getSharedEmbeddingCache(): EmbeddingCache {
  if (!sharedCache) {
    sharedCache = new EmbeddingCache();
  }
  return sharedCache;
}
