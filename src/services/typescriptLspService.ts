import * as monaco from 'monaco-editor';
import { FileService } from './fileService';
import { FileTreeIndexer } from '../utils/fileTreeIndex';
import { cachedBuildFileTree } from './agent/ipcCache';
import { logger } from '../utils/logger';
import type { FileTreeNode } from '../types/fileTree';
import { registerReactTypeLibraries } from './monacoTypeLibraries';

// Monaco v0.55+ marks languages.typescript as deprecated in types but it still works at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const monacoTs = monaco.languages.typescript as any;

class TypeScriptLspService {
  private static instance: TypeScriptLspService;
  private projectFiles: Map<string, string> = new Map();
  private models: Map<string, monaco.editor.ITextModel> = new Map();
  private isInitialized = false;
  /** Prevents concurrent initialize() calls from running global setup twice. */
  private isInitializing = false;
  /** Global Monaco setup (compiler options + providers) — runs once per app lifetime. */
  private globalSetupDone = false;
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
    // Guard against concurrent calls (e.g. two useEffect hooks firing for the same project).
    // Without this, both calls bypass the isInitialized check and both invoke
    // setupLanguageService() → setCompilerOptions(), which re-subscribes Monaco's
    // TypeScript worker to all existing models. Doing this N times creates N listener
    // copies per model, eventually hitting Monaco's 1000-listener leak threshold.
    if (this.isInitializing) {
      return;
    }

    this.isInitializing = true;
    try {
      this.rootPath = projectRoot;
      // Build the file index for path completion (does NOT create Monaco models)
      await this.buildFileIndex(projectRoot);

      // Global Monaco setup: compiler options + completion providers.
      // These configure Monaco-wide state (not per-project), so they must
      // only run ONCE per app lifetime. Running them on every initialize()
      // call causes Monaco's TS worker to re-subscribe to all models each
      // time, accumulating O(N * calls) listeners and eventually freezing.
      if (!this.globalSetupDone) {
        this.setupLanguageService();
        this.registerPathCompletionProviders();
        this.globalSetupDone = true;
      }

      this.isInitialized = true;
    } catch (error: unknown) {
      logger.error('editor', 'Failed to initialize TypeScript LSP service:', error);
    } finally {
      this.isInitializing = false;
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

  private async buildFileIndex(projectRoot: string) {
    try {
      // Build file tree for fast path lookups (used by path completion providers).
      // We do NOT create Monaco models here — models are only created when the user
      // actually opens a file in the editor. Pre-creating models for every project
      // file causes Monaco's observable system to accumulate 200+ listeners on shared
      // events, which freezes the app in projects with many TypeScript files.
      // Uses cachedBuildFileTree to avoid duplicate IPC if fileTreeStore already fetched.
      const fileTree = await cachedBuildFileTree<FileTreeNode>({
        rootPath: projectRoot,
        filter: { showHidden: false, maxDepth: 20 }
      });

      this.indexer.buildIndex(fileTree);
    } catch (error: unknown) {
      logger.error('editor', 'Failed to build file index:', error);
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
    registerReactTypeLibraries(monaco);
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

  /** Whether the service has been initialized with a project root. */
  get ready(): boolean {
    return this.isInitialized;
  }

  getFileContent(filePath: string): string | undefined {
    return this.projectFiles.get(filePath);
  }

  getAllFiles(): string[] {
    return Array.from(this.projectFiles.keys());
  }

  reset() {
    // Clear per-project files and their Monaco models.
    // Disposing a model removes its internal listeners from Monaco's global
    // event emitters — this is the correct cleanup path.
    this.projectFiles.clear();
    this.models.forEach(m => m.dispose());
    this.models.clear();

    // NOTE: We intentionally do NOT:
    //   - Call monacoTs.typescriptDefaults.setExtraLibs([]) — extra libs (DOM types)
    //     are global and survive project switches.
    //   - Dispose this.disposables (completion providers) — they're global providers
    //     that read this.rootPath at call-time, so they work for any project.
    //   - Reset globalSetupDone — compiler options and providers must not be re-applied.

    this.isInitialized = false;
    this.rootPath = null;
    // isInitializing stays false — reset() is never called while initialize() is running.
  }
}

export default TypeScriptLspService;
