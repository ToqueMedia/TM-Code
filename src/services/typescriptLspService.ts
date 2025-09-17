import * as monaco from 'monaco-editor';
import { FileTreeService } from './fileTreeService';
import type { FileTreeNode } from '../types/fileTree';

class TypeScriptLspService {
  private static instance: TypeScriptLspService;
  private projectFiles: Map<string, string> = new Map();
  private isInitialized = false;

  private constructor() {}

  static getInstance(): TypeScriptLspService {
    if (!TypeScriptLspService.instance) {
      TypeScriptLspService.instance = new TypeScriptLspService();
    }
    return TypeScriptLspService.instance;
  }

  async initialize(projectRoot: string) {
    if (this.isInitialized) {
      return;
    }

    try {
      // Load all TypeScript/JavaScript files in the project
      await this.loadProjectFiles(projectRoot);
      
      // Set up Monaco TypeScript language service
      this.setupLanguageService();
      
      this.isInitialized = true;
    } catch (error: unknown) {
      console.error('Failed to initialize TypeScript LSP service:', error);
    }
  }

  private async loadProjectFiles(projectRoot: string) {
    try {
      // Build file tree with filter for TypeScript/JavaScript files
      const fileTree = await FileTreeService.buildFileTree(projectRoot, {
        showHidden: false,
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
        maxDepth: undefined
      });

      // Traverse the file tree and load all relevant files
      const traverse = (node: FileTreeNode) => {
        if (node.type === 'file') {
          // Load file content
          this.loadFileContent(node.path);
        } else if (node.type === 'directory' && node.children) {
          node.children.forEach(traverse);
        }
      };

      traverse(fileTree);
    } catch (error: unknown) {
      console.error('Failed to load project files:', error);
    }
  }

  private async loadFileContent(filePath: string) {
    try {
      // For now, we'll just register the file path
      // In a real implementation, we would load the actual content
      this.projectFiles.set(filePath, '');
      
      // Add file to Monaco's virtual file system
      monaco.languages.typescript.typescriptDefaults.addExtraLib(
        '', // empty content for now
        `file://${filePath}`
      );
    } catch (error: unknown) {
      console.error(`Failed to load file content for ${filePath}:`, error);
    }
  }

  private setupLanguageService() {
    // Configure TypeScript compiler options for better IntelliSense
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      noEmit: true,
      esModuleInterop: true,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
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
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      noEmit: true,
      esModuleInterop: true,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      allowJs: true,
      checkJs: true,
      skipLibCheck: true,
      typeRoots: ['node_modules/@types']
    });

    // Add default libraries
    this.addDefaultLibraries();
  }

  private addDefaultLibraries() {
    // Add common DOM and Node.js type definitions
    // In a real implementation, you would load actual type definition files
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
    
    monaco.languages.typescript.typescriptDefaults.addExtraLib(domLib, 'file:///node_modules/@types/dom/index.d.ts');
  }

  async updateFileContent(filePath: string, content: string) {
    try {
      // Update file content in our cache
      this.projectFiles.set(filePath, content);
      
      // Update Monaco's virtual file system
      monaco.languages.typescript.typescriptDefaults.addExtraLib(
        content,
        `file://${filePath}`
      );
    } catch (error: unknown) {
      console.error(`Failed to update file content for ${filePath}:`, error);
    }
  }

  async addFile(filePath: string, content: string = '') {
    try {
      // Add file to our cache
      this.projectFiles.set(filePath, content);
      
      // Add file to Monaco's virtual file system
      monaco.languages.typescript.typescriptDefaults.addExtraLib(
        content,
        `file://${filePath}`
      );
    } catch (error: unknown) {
      console.error(`Failed to add file ${filePath}:`, error);
    }
  }

  async removeFile(filePath: string) {
    try {
      // Remove file from our cache
      this.projectFiles.delete(filePath);
      
      // Remove file from Monaco's virtual file system
      const extraLibs = monaco.languages.typescript.typescriptDefaults.getExtraLibs();
      const newExtraLibs = Object.keys(extraLibs).reduce((acc, key) => {
        if (key !== `file://${filePath}`) {
          acc[key] = extraLibs[key];
        }
        return acc;
      }, {} as { [key: string]: { content: string } });
      monaco.languages.typescript.typescriptDefaults.setExtraLibs(newExtraLibs as any);
    } catch (error: unknown) {
      console.error(`Failed to remove file ${filePath}:`, error);
    }
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
    
    // Reset Monaco's extra libraries
    monaco.languages.typescript.typescriptDefaults.setExtraLibs([]);
    
    this.isInitialized = false;
  }
}

export default TypeScriptLspService;