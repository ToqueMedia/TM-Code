// ToqueMedia Studio - TypeScript Syntax Highlighting Test
// Demonstra as cores customizadas para TypeScript

/**
 * Interface para configuração do editor
 * @description Testa highlighting de interfaces TypeScript
 */
interface EditorConfig {
  theme: 'dark' | 'light' | 'auto';
  fontSize: number;
  fontFamily?: string;
  readonly version: string;
}

/**
 * Type aliases para demonstrar syntax highlighting
 */
type Theme = 'toquemedia-vibrant' | 'toquemedia-soft' | 'vs-dark';
type EventHandler<T> = (event: T) => void;
type Optional<T> = T | null | undefined;

/**
 * Generic interface para testar types complexos
 */
interface Repository<T extends { id: string }> {
  findById(id: string): Promise<T | null>;
  save(entity: T): Promise<T>;
  delete(id: string): Promise<boolean>;
}

/**
 * Enum para testar cores de enums
 */
enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

/**
 * Classe abstrata para testar inheritance
 */
abstract class BaseEditor {
  protected abstract config: EditorConfig;
  
  abstract initialize(): Promise<void>;
  
  protected log(message: string, level: LogLevel = LogLevel.INFO): void {
    console.log(`[${level.toUpperCase()}] ${message}`);
  }
}

/**
 * Classe principal implementando a abstração
 */
class MonacoEditorWrapper extends BaseEditor {
  protected config: EditorConfig;
  private readonly instance: any;
  public isReady: boolean = false;
  
  // Constructor com parâmetros tipados
  constructor(
    config: EditorConfig,
    private readonly container: HTMLElement,
    private onReady?: EventHandler<void>
  ) {
    super();
    this.config = { ...config };
    this.instance = null;
  }
  
  // Implementação do método abstrato
  async initialize(): Promise<void> {
    try {
      this.log('Initializing Monaco Editor...', LogLevel.INFO);
      
      // Simulação de inicialização assíncrona
      await this.loadDependencies();
      await this.setupTheme();
      
      this.isReady = true;
      this.onReady?.(undefined);
      
      this.log('Monaco Editor initialized successfully', LogLevel.INFO);
    } catch (error) {
      this.log(`Failed to initialize: ${error}`, LogLevel.ERROR);
      throw error;
    }
  }
  
  // Método privado
  private async loadDependencies(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
  
  // Método com generics
  private async setupTheme<T extends Theme>(): Promise<T> {
    const theme = this.config.theme as T;
    
    // Operador de nullish coalescing
    const finalTheme = theme ?? 'toquemedia-vibrant' as T;
    
    return finalTheme;
  }
  
  // Getter/setter com tipos
  get currentConfig(): Readonly<EditorConfig> {
    return Object.freeze({ ...this.config });
  }
  
  set fontSize(size: number) {
    if (size < 8 || size > 72) {
      throw new Error('Font size must be between 8 and 72');
    }
    this.config.fontSize = size;
  }
  
  // Método com overloads
  setValue(content: string): void;
  setValue(content: string, language: string): void;
  setValue(content: string, language?: string): void {
    const lang = language || 'typescript';
    this.log(`Setting content with language: ${lang}`);
  }
  
  // Método estático
  static create(container: HTMLElement, config?: Partial<EditorConfig>): MonacoEditorWrapper {
    const defaultConfig: EditorConfig = {
      theme: 'dark',
      fontSize: 14,
      fontFamily: 'Monaco, Consolas, monospace',
      version: '1.0.0'
    };
    
    return new MonacoEditorWrapper(
      { ...defaultConfig, ...config },
      container
    );
  }
}

// Utility types
type Mutable<T> = {
  -readonly [P in keyof T]: T[P];
};

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// Conditional types
type ApiResponse<T> = T extends string 
  ? { message: T; success: true } 
  : { data: T; success: true } | { error: string; success: false };

// Mapped types
type EventMap = {
  'editor:ready': void;
  'editor:change': { content: string; language: string };
  'editor:error': Error;
};

type EventListeners<T> = {
  [K in keyof T]: EventHandler<T[K]>[];
};

// Template literal types
type CSSUnit = 'px' | 'em' | 'rem' | '%' | 'vh' | 'vw';
type Size = `${number}${CSSUnit}`;

// Funções com tipos complexos
function createEventEmitter<T extends Record<string, any>>(): {
  on<K extends keyof T>(event: K, handler: EventHandler<T[K]>): void;
  emit<K extends keyof T>(event: K, data: T[K]): void;
} {
  const listeners: Partial<EventListeners<T>> = {};
  
  return {
    on<K extends keyof T>(event: K, handler: EventHandler<T[K]>): void {
      if (!listeners[event]) {
        listeners[event] = [];
      }
      listeners[event]!.push(handler);
    },
    
    emit<K extends keyof T>(event: K, data: T[K]): void {
      listeners[event]?.forEach(handler => handler(data));
    }
  };
}

// Decorators (se habilitado)
function log(target: any, propertyName: string, descriptor: PropertyDescriptor): PropertyDescriptor {
  const method = descriptor.value;
  
  descriptor.value = function (...args: any[]) {
    console.log(`Calling ${propertyName} with arguments:`, args);
    const result = method.apply(this, args);
    console.log(`Method ${propertyName} returned:`, result);
    return result;
  };
  
  return descriptor;
}

// Async/await com error handling tipado
async function fetchWithRetry<T>(
  url: string,
  options?: RequestInit,
  retries: number = 3
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      return await response.json() as T;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  
  throw new Error('Max retries exceeded');
}

// Union types e type guards
type Shape = Circle | Rectangle | Triangle;

interface Circle {
  kind: 'circle';
  radius: number;
}

interface Rectangle {
  kind: 'rectangle';
  width: number;
  height: number;
}

interface Triangle {
  kind: 'triangle';
  base: number;
  height: number;
}

function calculateArea(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return Math.PI * shape.radius ** 2;
    case 'rectangle':
      return shape.width * shape.height;
    case 'triangle':
      return (shape.base * shape.height) / 2;
    default:
      // Exhaustive check
      const _exhaustive: never = shape;
      throw new Error(`Unknown shape: ${_exhaustive}`);
  }
}

// Export types and implementations
export type { EditorConfig, Theme, EventHandler, Optional, ApiResponse };
export { LogLevel, MonacoEditorWrapper, createEventEmitter, fetchWithRetry };
export default MonacoEditorWrapper;

// Este arquivo TypeScript demonstra:
// 💜 Keywords TypeScript em ROXO NEGRITO - Melhor visibilidade!
// 🔷 Interfaces e types em roxo elegante
// 💎 Generics e type parameters destacados
// 🟣 Enums em cores específicas
// 🔮 Decorators e annotations em roxo
// ⭐ Template literal types
// 💜 Operadores TypeScript em roxo claro
// 🎨 Syntax highlighting completo para TS com nova paleta ROXA!
