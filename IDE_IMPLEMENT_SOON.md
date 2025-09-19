# 🚀 Plano de Implementação - Funcionalidades Pendentes

## 📋 Resumo Executivo

Este documento detalha o plano de implementação para as **15% de funcionalidades restantes** do ToqueMedia Studio IDE, organizadas por prioridade e esforço estimado.

**Status Atual**: 85% implementado ✅  
**Objetivo**: Completar 100% das funcionalidades planejadas  
**Prazo Estimado**: 2-3 semanas  
**Prioridade**: Finalizar funcionalidades críticas primeiro

---

## 🎯 Funcionalidades Pendentes por Prioridade

### **🔴 PRIORIDADE ALTA (Críticas para Produção)**

#### **1. Go to Definition Completo**
- **Status**: ⚠️ Estrutura base implementada, falta handlers
- **Esforço**: 4-6 horas
- **Impacto**: Alto - funcionalidade essencial para IDE
- **Arquivos**: `src/services/typescriptLspService.ts`, `src/components/ui/MonacoEditor.tsx`

#### **2. Interface Git Visual**
- **Status**: ⚠️ Comandos funcionam via terminal, falta UI
- **Esforço**: 1-2 dias
- **Impacto**: Alto - workflow de desenvolvimento moderno
- **Arquivos**: Nova implementação necessária

---

### **🟡 PRIORIDADE MÉDIA (Importantes para UX)**

#### **3. Sistema de Plugins Básico**
- **Status**: ❌ Não iniciado
- **Esforço**: 3-4 dias
- **Impacto**: Médio - extensibilidade futura
- **Arquivos**: Nova arquitetura necessária

#### **4. Refatoração Avançada**
- **Status**: ⚠️ Básico implementado, falta interface dedicada
- **Esforço**: 2-3 dias
- **Impacto**: Médio - produtividade de desenvolvimento
- **Arquivos**: Extensão do LSP service

#### **5. Documentação Integrada**
- **Status**: ⚠️ Externa disponível, falta integração no IDE
- **Esforço**: 1-2 dias
- **Impacato**: Médio - self-service para usuários
- **Arquivos**: Novo painel de documentação

---

### **🟢 PRIORIDADE BAIXA (Nice-to-have)**

#### **6. Git Staging Visual**
- **Status**: ❌ Não iniciado
- **Esforço**: 2 dias
- **Impacto**: Baixo - complemento da interface Git
- **Arquivos**: Extensão da interface Git

#### **7. Marketplace de Plugins**
- **Status**: ❌ Não iniciado (depende do sistema de plugins)
- **Esforço**: 1 semana
- **Impacto**: Baixo - funcionalidade avançada
- **Arquivos**: Sistema complexo completo

---

## 📅 Cronograma de Implementação

### **Semana 1: Funcionalidades Críticas**

#### **Dia 1: Go to Definition Completo**
```typescript
// TAREFAS:
// 1. Implementar handlers completos no Monaco
// 2. Integração com TypeScript LSP
// 3. Testes de navegação
// 4. Suporte a múltiplas linguagens

// ARQUIVOS MODIFICADOS:
// - src/services/typescriptLspService.ts
// - src/components/ui/MonacoEditor.tsx
// - src/hooks/useMonacoTheme.ts
```

#### **Dias 2-3: Interface Git Visual Base**
```typescript
// TAREFAS:
// 1. Criar GitPanel component
// 2. Integração com comandos Git via Tauri
// 3. Status de arquivos (modified, staged, untracked)
// 4. Commit interface básica
// 5. Branch switching

// ARQUIVOS NOVOS:
// - src/components/ui/GitPanel.tsx
// - src/services/gitService.ts
// - src-tauri/src/commands/git.rs
// - src/hooks/useGitState.ts
```

#### **Dias 4-5: Testes e Polimento**
```typescript
// TAREFAS:
// 1. Testes das novas funcionalidades
// 2. Integração com keyboard shortcuts
// 3. Documentação das APIs
// 4. Bug fixes e otimizações
```

---

### **Semana 2: Funcionalidades Importantes**

#### **Dias 1-3: Sistema de Plugins Básico**
```typescript
// TAREFAS:
// 1. Arquitetura base de plugins
// 2. Plugin manifest system
// 3. API para plugins básicos
// 4. Sistema de carregamento dinâmico
// 5. Plugin de exemplo

// ARQUIVOS NOVOS:
// - src/plugins/PluginManager.ts
// - src/plugins/types.ts
// - src/plugins/examples/helloPlugin.ts
// - src/components/ui/PluginPanel.tsx
```

#### **Dias 4-5: Refatoração Avançada**
```typescript
// TAREFAS:
// 1. Interface para rename symbol
// 2. Extract method/variable
// 3. Organize imports
// 4. Find all references
// 5. Integration com Monaco context menu

// ARQUIVOS MODIFICADOS:
// - src/services/typescriptLspService.ts
// - src/components/ui/MonacoEditor.tsx
// - src/components/ui/RefactorPanel.tsx (novo)
```

---

### **Semana 3: Polimento e Extras**

#### **Dias 1-2: Documentação Integrada**
```typescript
// TAREFAS:
// 1. Help panel component
// 2. Contextual tooltips
// 3. Keyboard shortcuts reference
// 4. Feature walkthrough
// 5. Integration com activity bar

// ARQUIVOS NOVOS:
// - src/components/ui/HelpPanel.tsx
// - src/services/documentationService.ts
// - src/components/ui/FeatureWalkthrough.tsx
```

#### **Dias 3-5: Git Staging e Melhorias**
```typescript
// TAREFAS:
// 1. Git staging area visual
// 2. Diff viewer integrado
// 3. Commit history viewer
// 4. Conflict resolution helper
// 5. Git blame integration

// ARQUIVOS MODIFICADOS/NOVOS:
// - src/components/ui/GitPanel.tsx (extensão)
// - src/components/ui/DiffViewer.tsx
// - src/components/ui/CommitHistory.tsx
```

---

## 🛠️ Detalhamento Técnico por Funcionalidade

### **1. Go to Definition Completo**

#### **Implementação Required:**
```typescript
// src/services/typescriptLspService.ts
class TypeScriptLspService {
  async goToDefinition(filePath: string, position: monaco.Position) {
    // 1. Implementar definitionProvider
    // 2. Comunicação com TypeScript language server
    // 3. Retornar Location[] com arquivos e posições
    // 4. Handle cross-file navigation
  }
  
  async findReferences(filePath: string, position: monaco.Position) {
    // Similar para find all references
  }
}

// src/components/ui/MonacoEditor.tsx
function setupDefinitionProviders(monaco: Monaco, editor: editor.IStandaloneCodeEditor) {
  // 1. Register definition provider
  // 2. Register reference provider  
  // 3. Handle Ctrl+Click navigation
  // 4. Breadcrumb navigation integration
}
```

#### **Testes Necessários:**
- Navegação intra-arquivo
- Navegação cross-file
- Suporte a imports/exports
- Performance com projetos grandes

---

### **2. Interface Git Visual**

#### **Arquitetura:**
```typescript
// src/services/gitService.ts
class GitService {
  static shared = new GitService()
  
  async getStatus(): Promise<GitStatus>
  async stageFile(filePath: string): Promise<void>
  async unstageFile(filePath: string): Promise<void>
  async commit(message: string): Promise<void>
  async getCurrentBranch(): Promise<string>
  async listBranches(): Promise<string[]>
  async switchBranch(branch: string): Promise<void>
  async pull(): Promise<void>
  async push(): Promise<void>
}

// src/components/ui/GitPanel.tsx
function GitPanel() {
  // 1. File status tree (modified, staged, untracked)
  // 2. Commit message input
  // 3. Branch switcher
  // 4. Push/pull buttons
  // 5. Commit history list
}
```

#### **Backend Rust:**
```rust
// src-tauri/src/commands/git.rs
#[tauri::command]
async fn git_status(repo_path: String) -> Result<GitStatus, String> {
  // Use git2-rs crate para operações Git
}

#[tauri::command]
async fn git_stage_file(repo_path: String, file_path: String) -> Result<(), String> {
  // Stage individual files
}

// Adicionar todas as operações Git necessárias
```

---

### **3. Sistema de Plugins Básico**

#### **Arquitetura:**
```typescript
// src/plugins/types.ts
interface Plugin {
  id: string
  name: string
  version: string
  description: string
  author: string
  main: string
  contributes?: {
    commands?: Command[]
    menus?: Menu[]
    languages?: Language[]
  }
}

interface PluginContext {
  commands: CommandRegistry
  workspace: WorkspaceAPI
  editor: EditorAPI
}

// src/plugins/PluginManager.ts
class PluginManager {
  private plugins = new Map<string, Plugin>()
  
  async loadPlugin(manifest: Plugin): Promise<void>
  async unloadPlugin(id: string): Promise<void>
  getPlugins(): Plugin[]
  async executeCommand(command: string, ...args: any[]): Promise<any>
}
```

#### **Plugin de Exemplo:**
```typescript
// src/plugins/examples/helloPlugin.ts
export default {
  id: 'hello-world',
  name: 'Hello World Plugin',
  version: '1.0.0',
  
  activate(context: PluginContext) {
    context.commands.register('hello.world', () => {
      context.editor.showMessage('Hello from Plugin!')
    })
  },
  
  deactivate() {
    // Cleanup
  }
}
```

---

### **4. Refatoração Avançada**

#### **Funcionalidades:**
```typescript
// src/services/refactorService.ts
class RefactorService {
  static shared = new RefactorService()
  
  async renameSymbol(filePath: string, position: monaco.Position, newName: string) {
    // 1. Use LSP rename provider
    // 2. Apply changes across files
    // 3. Show preview before applying
  }
  
  async extractMethod(filePath: string, selection: monaco.Selection) {
    // 1. Analyze selected code
    // 2. Generate method signature
    // 3. Replace selection with method call
  }
  
  async organizeImports(filePath: string) {
    // 1. Remove unused imports
    // 2. Sort imports
    // 3. Group imports by type
  }
}

// Integration com Monaco Context Menu
function setupRefactorCommands(editor: editor.IStandaloneCodeEditor) {
  editor.addAction({
    id: 'refactor.rename',
    label: 'Rename Symbol',
    keybindings: [monaco.KeyCode.F2],
    contextMenuGroupId: 'refactor',
    run: async (editor) => {
      // Show rename widget
    }
  })
}
```

---

### **5. Documentação Integrada**

#### **Componentes:**
```typescript
// src/components/ui/HelpPanel.tsx
function HelpPanel() {
  // 1. Search documentation
  // 2. Contextual help based on cursor
  // 3. Keyboard shortcuts reference
  // 4. Feature tutorials
  // 5. API documentation for plugins
}

// src/services/documentationService.ts
class DocumentationService {
  async getContextualHelp(filePath: string, position: monaco.Position) {
    // Return relevant documentation
  }
  
  getKeyboardShortcuts() {
    // Return organized shortcuts by category
  }
  
  startWalkthrough(feature: string) {
    // Interactive feature introduction
  }
}
```

---

## 📦 Dependências Necessárias

### **NPM Packages:**
```json
{
  "dependencies": {
    "git2-rs": "^0.18.0",  // Para Rust Git operations
    "monaco-editor": "^0.45.0", // Atualização se necessário
    "@types/git": "^1.0.0"
  },
  "devDependencies": {
    "jest": "^29.0.0",  // Para testes das novas features
    "@testing-library/react": "^16.0.0"
  }
}
```

### **Rust Crates:**
```toml
[dependencies]
git2 = "0.18"  # Git operations
serde_json = "1.0"  # JSON serialization
tokio = { version = "1.0", features = ["full"] }
```

---

## 🧪 Plano de Testes

### **Testes por Funcionalidade:**

#### **Go to Definition:**
```typescript
describe('Go to Definition', () => {
  test('should navigate to function definition')
  test('should handle cross-file navigation')
  test('should work with imports/exports')
  test('should show error for undefined symbols')
})
```

#### **Git Interface:**
```typescript
describe('Git Interface', () => {
  test('should show git status correctly')
  test('should stage/unstage files')
  test('should commit with message')
  test('should switch branches')
  test('should handle merge conflicts')
})
```

#### **Plugin System:**
```typescript
describe('Plugin System', () => {
  test('should load plugin manifest')
  test('should execute plugin commands')
  test('should handle plugin errors')
  test('should unload plugins cleanly')
})
```

---

## 📈 Métricas de Sucesso

### **Critérios de Aceitação:**

1. **Go to Definition**: 
   - ✅ Funciona em 95% dos casos de uso TypeScript/JavaScript
   - ✅ Performance < 500ms para navegação
   - ✅ Suporte a bibliotecas externas

2. **Git Interface**:
   - ✅ UI intuitiva similar ao VSCode
   - ✅ Operações básicas funcionando
   - ✅ Status visual claro

3. **Sistema de Plugins**:
   - ✅ Plugin de exemplo funcional
   - ✅ API documentada
   - ✅ Carregamento dinâmico estável

4. **Refatoração**:
   - ✅ Rename symbol funcional
   - ✅ Preview antes de aplicar mudanças
   - ✅ Undo/redo suportado

5. **Documentação**:
   - ✅ Help contextual útil
   - ✅ Walkthrough para novas funcionalidades
   - ✅ Shortcuts reference accessible

---

## 🚦 Critérios de Priorização

### **Decidir Implementar Primeiro:**
1. **Impacto no Usuário** (Alto = Go to Definition)
2. **Complexidade** (Baixo = melhor começar)
3. **Dependências** (Plugins dependem de arquitetura)
4. **Tiempo de Desenvolvimento** (rápidos primeiro)

### **Ordem Recomendada:**
1. 🔴 **Go to Definition** (4-6h, impacto alto)
2. 🔴 **Git Interface básica** (1-2 dias, workflow essencial)
3. 🟡 **Documentação integrada** (1-2 dias, facilita uso)
4. 🟡 **Refatoração avançada** (2-3 dias, produtividade)
5. 🟡 **Sistema de Plugins** (3-4 dias, extensibilidade)
6. 🟢 **Git Staging visual** (2 dias, polish)

---

## 🎯 Próximos Passos Imediatos

### **Esta Semana (19-25 Setembro 2025):**
1. **Segunda**: Implementar Go to Definition handlers
2. **Terça**: Completar navegação cross-file
3. **Quarta-Quinta**: Iniciar Git interface básica
4. **Sexta**: Testes e integração

### **Próxima Semana:**
1. **Completar Git interface**
2. **Iniciar sistema de plugins**
3. **Documentação das novas features**

---

## 📝 Notas Importantes

### **Considerações de Arquitetura:**
- Manter compatibilidade com sistema existente
- Usar padrões já estabelecidos no projeto
- Garantir que novas funcionalidades são testáveis
- Documentar APIs para futuras extensões

### **Performance:**
- Não comprometer performance existente
- Implementar lazy loading onde possível
- Cache inteligente para operações Git
- Debounce para operações LSP

### **UX:**
- Manter consistência visual com interface existente
- Keyboard shortcuts intuitivos
- Feedback visual claro para operações assíncronas
- Error handling graceful

---

**📅 Última Atualização**: 19 de Setembro de 2025  
**👤 Responsável**: Equipe ToqueMedia Studio  
**🎯 Objetivo**: Completar 100% das funcionalidades IDE_Basic.md

---

*Este plano será atualizado conforme o progresso das implementações.*