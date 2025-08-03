import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { log } from '../logging.js';

export interface RepositoryContext {
  projectType: 'web-app' | 'api' | 'cli' | 'library' | 'mobile' | 'data-processing' | 'ml-pipeline' | 'game' | 'dev-tools' | 'unknown';
  primaryLanguages: string[];
  frameworks: string[];
  domain: string;
  architecturalStyle: 'monolithic' | 'microservices' | 'serverless' | 'mixed' | 'unknown';
  buildTools: string[];
  testingFrameworks: string[];
  
  // Caching metadata
  contextHash: string;
  lastUpdated: Date;
  structuralFiles: Array<{path: string, hash: string}>;
}

export interface AnalysisCheckpoint {
  lastAnalyzedCommit: string | null;
  lastProcessedVibeSession: string | null;
  lastFullAnalysis: Date | null;
  repositoryContextVersion: string;
  
  // Progress tracking
  processedCommitCount: number;
  processedVibeSessionCount: number;
  extractedPatterns: number;
  
  // Quality metrics
  analysisCompleteness: number; // 0-100%
  confidenceScore: number;
}

export class RepositoryContextManager {
  private repositoryPath: string;
  private contextCache: RepositoryContext | null = null;
  private checkpointCache: AnalysisCheckpoint | null = null;
  
  // Files that affect repository context
  private readonly STRUCTURAL_FILES = [
    'package.json',
    'requirements.txt', 
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    'composer.json',
    'README.md',
    'README.rst',
    'tsconfig.json',
    'pyproject.toml',
    'setup.py',
    'Dockerfile',
    'docker-compose.yml',
    '.env.example'
  ];

  constructor(repositoryPath: string = '.') {
    this.repositoryPath = repositoryPath;
  }

  async getRepositoryContext(forceRefresh: boolean = false): Promise<RepositoryContext> {
    if (!forceRefresh && this.contextCache && this.isCacheValid(this.contextCache)) {
      log('Using cached repository context', 'info');
      return this.contextCache;
    }

    log('Analyzing repository context', 'info');
    const context = await this.analyzeRepositoryContext();
    this.contextCache = context;
    
    return context;
  }

  async getAnalysisCheckpoint(): Promise<AnalysisCheckpoint> {
    if (!this.checkpointCache) {
      this.checkpointCache = this.loadCheckpointFromMetadata();
    }
    return this.checkpointCache;
  }

  async updateCheckpoint(updates: Partial<AnalysisCheckpoint>): Promise<void> {
    const current = await this.getAnalysisCheckpoint();
    this.checkpointCache = { ...current, ...updates };
    
    // Note: In real implementation, this would update the shared-memory-*.json metadata
    log('Checkpoint updated', 'info', updates);
  }

  private async analyzeRepositoryContext(): Promise<RepositoryContext> {
    const structuralFiles = this.findStructuralFiles();
    const contextHash = this.calculateContextHash(structuralFiles);
    
    // Analyze different aspects
    const projectType = this.detectProjectType(structuralFiles);
    const primaryLanguages = this.detectPrimaryLanguages();
    const frameworks = this.detectFrameworks(structuralFiles);
    const domain = this.inferDomain(structuralFiles, frameworks);
    const architecturalStyle = this.detectArchitecturalStyle();
    const buildTools = this.detectBuildTools(structuralFiles);
    const testingFrameworks = this.detectTestingFrameworks(structuralFiles);

    return {
      projectType,
      primaryLanguages,
      frameworks,
      domain,
      architecturalStyle,
      buildTools,
      testingFrameworks,
      contextHash,
      lastUpdated: new Date(),
      structuralFiles: structuralFiles.map(file => ({
        path: file,
        hash: this.calculateFileHash(file)
      }))
    };
  }

  private detectProjectType(structuralFiles: string[]): RepositoryContext['projectType'] {
    const fileSet = new Set(structuralFiles.map(f => path.basename(f)));
    
    // Check for specific project types
    if (fileSet.has('package.json')) {
      const packageJson = this.readJsonFile('package.json');
      if (packageJson) {
        // Check dependencies for clues
        const allDeps = {
          ...packageJson.dependencies || {},
          ...packageJson.devDependencies || {}
        };
        
        if (allDeps['react'] || allDeps['vue'] || allDeps['angular']) {
          return 'web-app';
        }
        if (allDeps['express'] || allDeps['fastify'] || allDeps['koa']) {
          return 'api';
        }
        if (packageJson.bin || allDeps['commander'] || allDeps['yargs']) {
          return 'cli';
        }
        if (!packageJson.main && !packageJson.bin) {
          return 'library';
        }
      }
    }

    if (fileSet.has('requirements.txt') || fileSet.has('pyproject.toml')) {
      // Python project - analyze further
      if (this.checkDirectoryExists('notebooks') || this.checkFilePatterns(['*.ipynb'])) {
        return 'ml-pipeline';
      }
      if (this.checkDirectoryExists('api') || this.checkFilePatterns(['**/app.py', '**/main.py'])) {
        return 'api';
      }
    }

    if (fileSet.has('Cargo.toml')) {
      const cargoToml = this.readTomlFile('Cargo.toml');
      if (cargoToml?.bin) {
        return 'cli';
      }
    }

    // Fallback based on directory structure
    if (this.checkDirectoryExists('src/components') || this.checkDirectoryExists('components')) {
      return 'web-app';
    }
    if (this.checkDirectoryExists('routes') || this.checkDirectoryExists('controllers')) {
      return 'api';
    }
    if (this.checkDirectoryExists('cmd') || this.checkDirectoryExists('cli')) {
      return 'cli';
    }

    return 'unknown';
  }

  private detectPrimaryLanguages(): string[] {
    const languages: Record<string, number> = {};
    
    const countFiles = (dir: string, extensions: string[], language: string) => {
      try {
        const files = this.getAllFiles(dir);
        const count = files.filter(file => 
          extensions.some(ext => file.endsWith(ext))
        ).length;
        if (count > 0) {
          languages[language] = (languages[language] || 0) + count;
        }
      } catch (error) {
        // Directory doesn't exist, skip
      }
    };

    countFiles('src', ['.ts', '.tsx'], 'TypeScript');
    countFiles('src', ['.js', '.jsx'], 'JavaScript');
    countFiles('.', ['.py'], 'Python');
    countFiles('src', ['.java'], 'Java');
    countFiles('src', ['.rs'], 'Rust');
    countFiles('src', ['.go'], 'Go');
    countFiles('src', ['.cpp', '.cc', '.cxx'], 'C++');
    countFiles('src', ['.c'], 'C');

    // Sort by file count and return top languages
    return Object.entries(languages)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([lang]) => lang);
  }

  private detectFrameworks(structuralFiles: string[]): string[] {
    const frameworks: string[] = [];
    
    // Check package.json
    const packageJson = this.readJsonFile('package.json');
    if (packageJson) {
      const allDeps = {
        ...packageJson.dependencies || {},
        ...packageJson.devDependencies || {}
      };
      
      const frameworkMap: Record<string, string> = {
        'react': 'React',
        'vue': 'Vue.js',
        '@angular/core': 'Angular',
        'express': 'Express.js',
        'fastify': 'Fastify',
        'koa': 'Koa.js',
        'next': 'Next.js',
        'nuxt': 'Nuxt.js',
        'svelte': 'Svelte',
        'jest': 'Jest',
        'mocha': 'Mocha',
        'cypress': 'Cypress',
        'playwright': 'Playwright'
      };
      
      Object.keys(allDeps).forEach(dep => {
        if (frameworkMap[dep]) {
          frameworks.push(frameworkMap[dep]);
        }
      });
    }

    // Check Python requirements
    const requirements = this.readTextFile('requirements.txt');
    if (requirements) {
      const pythonFrameworks: Record<string, string> = {
        'django': 'Django',
        'flask': 'Flask',
        'fastapi': 'FastAPI',
        'tensorflow': 'TensorFlow',
        'pytorch': 'PyTorch',
        'scikit-learn': 'scikit-learn',
        'pandas': 'Pandas',
        'numpy': 'NumPy'
      };
      
      Object.keys(pythonFrameworks).forEach(pkg => {
        if (requirements.toLowerCase().includes(pkg)) {
          frameworks.push(pythonFrameworks[pkg]);
        }
      });
    }

    return [...new Set(frameworks)]; // Remove duplicates
  }

  private inferDomain(structuralFiles: string[], frameworks: string[]): string {
    // Analyze frameworks and directory structure to infer domain
    if (frameworks.some(f => ['TensorFlow', 'PyTorch', 'scikit-learn'].includes(f))) {
      return 'Machine Learning';
    }
    if (frameworks.some(f => ['React', 'Vue.js', 'Angular'].includes(f))) {
      return 'Web Frontend';
    }
    if (frameworks.some(f => ['Express.js', 'FastAPI', 'Django'].includes(f))) {
      return 'Web Backend';
    }
    if (this.checkDirectoryExists('mobile') || this.checkFilePatterns(['**/*.swift', '**/*.kt'])) {
      return 'Mobile Development';
    }
    if (this.checkDirectoryExists('game') || this.checkFilePatterns(['**/*.unity', '**/*.godot'])) {
      return 'Game Development';
    }
    if (this.checkDirectoryExists('data') || this.checkFilePatterns(['**/*.ipynb', '**/pipeline.py'])) {
      return 'Data Processing';
    }

    // Analyze README for domain keywords
    const readme = this.readTextFile('README.md') || this.readTextFile('README.rst') || '';
    const domainKeywords = {
      'e-commerce': ['shop', 'cart', 'payment', 'order', 'checkout'],
      'fintech': ['bank', 'finance', 'payment', 'trading', 'investment'],
      'healthcare': ['medical', 'health', 'patient', 'doctor', 'clinic'],
      'education': ['course', 'student', 'learning', 'education', 'classroom'],
      'social': ['social', 'chat', 'message', 'friend', 'community'],
      'productivity': ['task', 'todo', 'project', 'team', 'collaboration'],
      'developer tools': ['cli', 'tool', 'build', 'deploy', 'developer']
    };

    for (const [domain, keywords] of Object.entries(domainKeywords)) {
      if (keywords.some(keyword => readme.toLowerCase().includes(keyword))) {
        return domain;
      }
    }

    return 'General Software';
  }

  private detectArchitecturalStyle(): RepositoryContext['architecturalStyle'] {
    // Check for microservices indicators
    if (this.checkFileExists('docker-compose.yml') || 
        this.checkDirectoryExists('services') ||
        this.checkDirectoryExists('microservices')) {
      return 'microservices';
    }

    // Check for serverless indicators
    if (this.checkFileExists('serverless.yml') ||
        this.checkFileExists('sam.yml') ||
        this.checkDirectoryExists('lambda') ||
        this.checkDirectoryExists('functions')) {
      return 'serverless';
    }

    // Default to monolithic for single-service applications
    return 'monolithic';
  }

  private detectBuildTools(structuralFiles: string[]): string[] {
    const tools: string[] = [];
    
    const fileSet = new Set(structuralFiles.map(f => path.basename(f)));
    
    if (fileSet.has('package.json')) tools.push('npm/yarn');
    if (fileSet.has('Cargo.toml')) tools.push('Cargo');
    if (fileSet.has('pom.xml')) tools.push('Maven');
    if (fileSet.has('build.gradle')) tools.push('Gradle');
    if (fileSet.has('requirements.txt') || fileSet.has('pyproject.toml')) tools.push('pip');
    if (fileSet.has('Dockerfile')) tools.push('Docker');
    if (this.checkFileExists('webpack.config.js')) tools.push('Webpack');
    if (this.checkFileExists('vite.config.js') || this.checkFileExists('vite.config.ts')) tools.push('Vite');
    
    return tools;
  }

  private detectTestingFrameworks(structuralFiles: string[]): string[] {
    const frameworks: string[] = [];
    
    // Check package.json for testing dependencies
    const packageJson = this.readJsonFile('package.json');
    if (packageJson) {
      const allDeps = {
        ...packageJson.dependencies || {},
        ...packageJson.devDependencies || {}
      };
      
      if (allDeps['jest']) frameworks.push('Jest');
      if (allDeps['mocha']) frameworks.push('Mocha');
      if (allDeps['jasmine']) frameworks.push('Jasmine');
      if (allDeps['cypress']) frameworks.push('Cypress');
      if (allDeps['playwright']) frameworks.push('Playwright');
      if (allDeps['@testing-library/react']) frameworks.push('Testing Library');
    }

    // Check for Python testing frameworks
    const requirements = this.readTextFile('requirements.txt');
    if (requirements) {
      if (requirements.includes('pytest')) frameworks.push('pytest');
      if (requirements.includes('unittest')) frameworks.push('unittest');
      if (requirements.includes('nose')) frameworks.push('nose');
    }

    return frameworks;
  }

  private isCacheValid(context: RepositoryContext): boolean {
    // Check if any structural files have changed
    for (const file of context.structuralFiles) {
      const currentHash = this.calculateFileHash(file.path);
      if (currentHash !== file.hash) {
        log(`File changed: ${file.path}`, 'info');
        return false;
      }
    }
    
    // Cache is valid for 24 hours maximum
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    if (Date.now() - context.lastUpdated.getTime() > maxAge) {
      log('Context cache expired', 'info');
      return false;
    }
    
    return true;
  }

  private findStructuralFiles(): string[] {
    const found: string[] = [];
    
    for (const file of this.STRUCTURAL_FILES) {
      const fullPath = path.join(this.repositoryPath, file);
      if (fs.existsSync(fullPath)) {
        found.push(file);
      }
    }
    
    return found;
  }

  private calculateContextHash(structuralFiles: string[]): string {
    const hasher = crypto.createHash('md5');
    
    for (const file of structuralFiles) {
      const fileHash = this.calculateFileHash(file);
      hasher.update(fileHash);
    }
    
    return hasher.digest('hex');
  }

  private calculateFileHash(filePath: string): string {
    try {
      const fullPath = path.join(this.repositoryPath, filePath);
      const content = fs.readFileSync(fullPath);
      return crypto.createHash('md5').update(content).digest('hex');
    } catch (error) {
      return '';
    }
  }

  private loadCheckpointFromMetadata(): AnalysisCheckpoint {
    // In real implementation, this would load from shared-memory-*.json metadata
    // For now, return default checkpoint
    return {
      lastAnalyzedCommit: null,
      lastProcessedVibeSession: null,
      lastFullAnalysis: null,
      repositoryContextVersion: '',
      processedCommitCount: 0,
      processedVibeSessionCount: 0,
      extractedPatterns: 0,
      analysisCompleteness: 0,
      confidenceScore: 0
    };
  }

  // Utility methods
  private readJsonFile(filePath: string): any {
    try {
      const fullPath = path.join(this.repositoryPath, filePath);
      const content = fs.readFileSync(fullPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  private readTextFile(filePath: string): string | null {
    try {
      const fullPath = path.join(this.repositoryPath, filePath);
      return fs.readFileSync(fullPath, 'utf8');
    } catch (error) {
      return null;
    }
  }

  private readTomlFile(filePath: string): any {
    // Simple TOML parsing - in production, use a proper TOML library
    try {
      const content = this.readTextFile(filePath);
      if (!content) return null;
      
      // Very basic TOML parsing for common cases
      const result: any = {};
      const lines = content.split('\n');
      
      for (const line of lines) {
        if (line.includes('[[bin]]')) {
          result.bin = true;
        }
      }
      
      return result;
    } catch (error) {
      return null;
    }
  }

  private checkFileExists(filePath: string): boolean {
    const fullPath = path.join(this.repositoryPath, filePath);
    return fs.existsSync(fullPath);
  }

  private checkDirectoryExists(dirPath: string): boolean {
    const fullPath = path.join(this.repositoryPath, dirPath);
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
  }

  private checkFilePatterns(patterns: string[]): boolean {
    // Simple pattern matching - in production, use glob library
    for (const pattern of patterns) {
      // This is a simplified implementation
      const cleanPattern = pattern.replace('**/', '').replace('*', '');
      const files = this.getAllFiles('.');
      if (files.some(file => file.includes(cleanPattern))) {
        return true;
      }
    }
    return false;
  }

  private getAllFiles(dir: string): string[] {
    const files: string[] = [];
    
    try {
      const fullDir = path.join(this.repositoryPath, dir);
      const entries = fs.readdirSync(fullDir);
      
      for (const entry of entries) {
        const fullPath = path.join(fullDir, entry);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
          files.push(...this.getAllFiles(path.join(dir, entry)));
        } else if (stat.isFile()) {
          files.push(path.join(dir, entry));
        }
      }
    } catch (error) {
      // Directory doesn't exist or can't be read
    }
    
    return files;
  }
}