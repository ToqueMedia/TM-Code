import * as monaco from 'monaco-editor';
import { FileTreeService } from './fileTreeService';
import { FileService } from './fileService';
import type { FileTreeNode } from '../types/fileTree';
import { FileTreeIndexer } from '../utils/fileTreeIndex';
import { logger } from '../utils/logger';

// Monaco v0.55+ marks languages.typescript as deprecated in types but it still works at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const monacoTs = monaco.languages.typescript as any;

class TypeScriptLspService {
  private static instance: TypeScriptLspService;
  private projectFiles: Map<string, string> = new Map();
  private models: Map<string, monaco.editor.ITextModel> = new Map();
  private isInitialized = false;
  private rootPath: string | null = null;
  private indexer = FileTreeIndexer.getInstance();
  private disposables: monaco.IDisposable[] = [];

  private constructor() {}

  static getInstance(): TypeScriptLspService {
    if (!TypeScriptLspService.instance) {
      TypeScriptLspService.instance = new TypeScriptLspService();
    }
    return TypeScriptLspService.instance;
  }

  async initialize(projectRoot: string) {
    if (this.isInitialized && this.rootPath === projectRoot) {
      return;
    }

    try {
      this.rootPath = projectRoot;
      // Load all TypeScript/JavaScript files in the project
      await this.loadProjectFiles(projectRoot);
      
      // Set up Monaco TypeScript language service
      this.setupLanguageService();

      // Register path completion providers
      this.registerPathCompletionProviders();
      
      this.isInitialized = true;
    } catch (error: unknown) {
      logger.error('editor', 'Failed to initialize TypeScript LSP service:', error);
    }
  }

  private getLanguageFromExtension(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'ts': return 'typescript';
      case 'tsx': return 'typescript';
      case 'js': return 'javascript';
      case 'jsx': return 'javascript';
      case 'json': return 'json';
      case 'html': return 'html';
      case 'css': return 'css';
      default: return 'plaintext';
    }
  }

  private createOrUpdateModel(filePath: string, content: string, language: string) {
    const uri = monaco.Uri.file(filePath);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(content, language, uri);
    } else {
      if (model.getValue() !== content) {
        model.setValue(content);
      }
    }
    this.models.set(filePath, model);
  }

  private async loadProjectFiles(projectRoot: string) {
    try {
      // Build file tree (Rust side). Note: current Rust implementation doesn't filter by extensions.
      const fileTree = await FileTreeService.buildFileTree(projectRoot, {
        showHidden: false,
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css'],
        maxDepth: undefined
      });

      // Build index for fast path lookups
      this.indexer.buildIndex(fileTree);

      // Allowed extensions and excluded directories to avoid creating excessive Monaco models
      const allowed = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'html', 'css']);
      const excludedDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo']);
      const MODEL_LIMIT = 1000;
      let modelCount = 0;

      // Traverse the file tree and load only relevant files
      const traverse = async (node: FileTreeNode) => {
        if (node.type === 'file') {
          const ext = node.extension ? node.extension.toLowerCase() : '';
          if (!allowed.has(ext)) return;
          if (modelCount >= MODEL_LIMIT) return;
          await this.loadFileContent(node.path);
          modelCount++;
        } else if (node.type === 'directory' && node.children) {
          // Skip heavy/common build folders
          const name = node.name.toLowerCase();
          if (excludedDirs.has(name)) return;
          for (const child of node.children) {
            await traverse(child);
          }
        }
      };

      await traverse(fileTree);
    } catch (error: unknown) {
      logger.error('editor', 'Failed to load project files:', error);
    }
  }

  private async loadFileContent(filePath: string) {
    try {
      const content = await FileService.readFile(filePath);
      this.projectFiles.set(filePath, content);
      const language = this.getLanguageFromExtension(filePath);
      this.createOrUpdateModel(filePath, content, language);
    } catch (error: unknown) {
      logger.error('editor', `Failed to load file content for ${filePath}:`, error);
    }
  }

  private setupLanguageService() {
    // Configure TypeScript compiler options for better IntelliSense
    monacoTs.typescriptDefaults.setCompilerOptions({
      target: monacoTs.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      moduleResolution: monacoTs.ModuleResolutionKind.NodeJs,
      module: monacoTs.ModuleKind.ESNext,
      noEmit: true,
      esModuleInterop: true,
      jsx: monacoTs.JsxEmit.ReactJSX,
      reactNamespace: 'React',
      allowJs: true,
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      strictFunctionTypes: true,
      strictBindCallApply: true,
      strictPropertyInitialization: true,
      noImplicitThis: true,
      noImplicitReturns: true,
      alwaysStrict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: true,
      skipLibCheck: true,
      typeRoots: ['node_modules/@types']
    });

    // Configure JavaScript compiler options
    monacoTs.javascriptDefaults.setCompilerOptions({
      target: monacoTs.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      moduleResolution: monacoTs.ModuleResolutionKind.NodeJs,
      module: monacoTs.ModuleKind.ESNext,
      noEmit: true,
      esModuleInterop: true,
      jsx: monacoTs.JsxEmit.ReactJSX,
      allowJs: true,
      checkJs: true,
      skipLibCheck: true,
      typeRoots: ['node_modules/@types']
    });

    // Add default libraries
    this.addDefaultLibraries();
  }

  private addDefaultLibraries() {
    const domLib = `
      interface Window {
        document: Document;
        addEventListener(type: string, listener: EventListener): void;
      }
      
      interface Document {
        getElementById(id: string): HTMLElement | null;
        querySelector(selectors: string): Element | null;
      }
      
      interface HTMLElement {
        style: CSSStyleDeclaration;
        addEventListener(type: string, listener: EventListener): void;
      }
    `;
    
    monacoTs.typescriptDefaults.addExtraLib(domLib, 'file:///node_modules/@types/dom/index.d.ts');
  }

  async updateFileContent(filePath: string, content: string) {
    try {
      this.projectFiles.set(filePath, content);
      const language = this.getLanguageFromExtension(filePath);
      this.createOrUpdateModel(filePath, content, language);
    } catch (error: unknown) {
      logger.error('editor', `Failed to update file content for ${filePath}:`, error);
    }
  }

  async addFile(filePath: string, content: string = '') {
    try {
      this.projectFiles.set(filePath, content);
      const language = this.getLanguageFromExtension(filePath);
      this.createOrUpdateModel(filePath, content, language);
    } catch (error: unknown) {
      logger.error('editor', `Failed to add file ${filePath}:`, error);
    }
  }

  async removeFile(filePath: string) {
    try {
      this.projectFiles.delete(filePath);
      const model = this.models.get(filePath) || monaco.editor.getModel(monaco.Uri.file(filePath));
      if (model) {
        model.dispose();
        this.models.delete(filePath);
      }
    } catch (error: unknown) {
      logger.error('editor', `Failed to remove file ${filePath}:`, error);
    }
  }

  async renameFileModel(oldPath: string, newPath: string) {
    try {
      const oldUri = monaco.Uri.file(oldPath);
      const oldModel = monaco.editor.getModel(oldUri);
      if (!oldModel) return;
      const content = oldModel.getValue();
      const language = this.getLanguageFromExtension(newPath);
      // Create new model and dispose old
      this.createOrUpdateModel(newPath, content, language);
      oldModel.dispose();
      this.models.delete(oldPath);
    } catch (error) {
      logger.error('editor', `Failed to rename model ${oldPath} -> ${newPath}:`, error);
    }
  }

  private registerPathCompletionProviders() {
    const provide = async (model: monaco.editor.ITextModel, position: monaco.Position) => {
      try {
        if (!this.rootPath) return { suggestions: [] as monaco.languages.CompletionItem[] };

        const line = model.getLineContent(position.lineNumber);
        const uptoColumn = line.slice(0, position.column - 1);
        // Detect if we are inside import path string
        const importMatch = uptoColumn.match(/(?:import\s+[^;]*from\s+|require\()\s*['"]([^'"]*)$/);
        if (!importMatch) return { suggestions: [] as monaco.languages.CompletionItem[] };
        const typedPath = importMatch[1];

        // Resolve base directory
        const currentDir = model.uri.path.substring(0, model.uri.path.lastIndexOf('/'));
        const resolvedDir = this.resolveRelative(currentDir, typedPath);

        const children = this.indexer.getChildren(this.rootPath, resolvedDir) || [];
        const suggestions: monaco.languages.CompletionItem[] = children.map(child => {
          const isDir = child.type === 'directory';
          const label = child.name + (isDir ? '/' : '');
          return {
            label,
            kind: isDir ? monaco.languages.CompletionItemKind.Folder : monaco.languages.CompletionItemKind.File,
            insertText: label,
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
          };
        });

        return { suggestions };
      } catch {
        return { suggestions: [] as monaco.languages.CompletionItem[] };
      }
    };

    const tsProvider = monaco.languages.registerCompletionItemProvider('typescript', {
      triggerCharacters: ['/', '.', "'", '"'],
      provideCompletionItems: provide as unknown as monaco.languages.CompletionItemProvider['provideCompletionItems'],
    });
    const jsProvider = monaco.languages.registerCompletionItemProvider('javascript', {
      triggerCharacters: ['/', '.', "'", '"'],
      provideCompletionItems: provide as unknown as monaco.languages.CompletionItemProvider['provideCompletionItems'],
    });

    this.disposables.push(tsProvider, jsProvider);
  }

  private resolveRelative(fromDir: string, typed: string): string {
    if (typed.startsWith('/')) return typed; // absolute within root index
    let base = fromDir;
    let rest = typed;
    if (typed.startsWith('./')) {
      rest = typed.slice(2);
    }
    while (rest.startsWith('../')) {
      rest = rest.slice(3);
      base = base.substring(0, Math.max(0, base.lastIndexOf('/')));
      if (base === '') base = '/';
    }
    const joined = base.endsWith('/') ? base + rest : base + '/' + rest;
    // Normalize double slashes
    return joined.replace(/\/+/g, '/');
  }

  /**
   * Get TypeScript/JavaScript diagnostics for a file using Monaco's language worker.
   * Returns semantic + syntactic diagnostics with line/column positions.
   */
  async getDiagnostics(filePath: string): Promise<Array<{
    line: number
    column: number
    message: string
    severity: 'error' | 'warning' | 'info'
    code: number
  }>> {
    const uri = monaco.Uri.file(filePath);
    let model = monaco.editor.getModel(uri);

    // If model doesn't exist, try to load the file first
    if (!model) {
      await this.loadFileContent(filePath);
      model = monaco.editor.getModel(uri);
    }

    if (!model) {
      throw new Error(`File not loaded in editor: ${filePath}`);
    }

    const isTs = filePath.endsWith('.ts') || filePath.endsWith('.tsx');
    const getWorker = isTs
      ? await monacoTs.getTypeScriptWorker()
      : await monacoTs.getJavaScriptWorker();

    const worker = await getWorker(uri);

    const [semantic, syntactic] = await Promise.all([
      worker.getSemanticDiagnostics(uri.toString()),
      worker.getSyntacticDiagnostics(uri.toString()),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return [...syntactic, ...semantic].map((d: any) => {
      const pos = model.getPositionAt(d.start);
      const messageText = typeof d.messageText === 'string'
        ? d.messageText
        : d.messageText?.messageText || 'Unknown error';

      return {
        line: pos.lineNumber,
        column: pos.column,
        message: messageText,
        severity: d.category === 1 ? 'error' as const : d.category === 0 ? 'warning' as const : 'info' as const,
        code: d.code,
      };
    });
  }

  getFileContent(filePath: string): string | undefined {
    return this.projectFiles.get(filePath);
  }

  getAllFiles(): string[] {
    return Array.from(this.projectFiles.keys());
  }

  reset() {
    // Clear all files
    this.projectFiles.clear();
    this.models.forEach(m => m.dispose());
    this.models.clear();
    
    // Reset Monaco's extra libraries
    monacoTs.typescriptDefaults.setExtraLibs([]);

    // Dispose providers
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    
    this.isInitialized = false;
    this.rootPath = null;
  }
}

export default TypeScriptLspService;
