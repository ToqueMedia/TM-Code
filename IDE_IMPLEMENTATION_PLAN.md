# 🚀 ToqueMedia Studio - Plano de Implementação IDE

## 📊 Estado Atual do Projeto

### ✅ Funcionalidades Implementadas
- [x] Monaco Editor com tema roxo customizado
- [x] File Tree/Explorer completo com ícones
- [x] Sistema de gerenciamento de projetos
- [x] TypeScript LSP integrado
- [x] File Watcher para mudanças automáticas
- [x] Search Panel (busca básica)
- [x] State Management com Zustand
- [x] Layout responsivo com Chakra UI v3
- [x] Sistema de atalhos básicos

### ❌ Funcionalidades Faltantes (Por Prioridade)

---

## 🎯 FASE 1: Terminal Integrado (CRÍTICO) 
**Branch**: `feature/terminal-integration`
**Duração**: 3-4 dias

### Tarefas:
1. **Instalar xterm.js e dependências**
   ```bash
   npm install xterm @xterm/addon-fit @xterm/addon-web-links
   ```

2. **Criar Terminal Component**
   - `src/components/ui/Terminal.tsx`
   - Integração com xterm.js
   - Resize automático com addon-fit

3. **Criar Terminal Service**
   - `src/services/terminalService.ts`
   - Comandos Tauri para shell execution
   - Gerenciamento de processos

4. **Integrar ao BottomPanel**
   - Adicionar aba Terminal
   - Controles de clear/kill process

5. **Comandos Tauri (Rust)**
   - `execute_command`
   - `kill_process`
   - Stream de output

---

## 🔍 FASE 2: Busca Global Avançada (CRÍTICO)
**Branch**: `feature/global-search`
**Duração**: 2-3 dias

### Tarefas:
1. **Expandir SearchPanel existente**
   - Busca em todo o projeto
   - Regex support
   - Filtros por tipo de arquivo

2. **Integrar ripgrep via Tauri**
   - Comando Rust para busca rápida
   - Parsing de resultados
   - Cancelamento de busca

3. **UI de Resultados**
   - Lista de arquivos encontrados
   - Preview de linhas
   - Navegação para resultados

4. **Atalho Ctrl+Shift+F**
   - Expandir useKeyboardShortcuts

---

## ⚡ FASE 3: Execução de Código (CRÍTICO)
**Branch**: `feature/code-execution`  
**Duração**: 3-4 dias

### Tarefas:
1. **Run Configuration System**
   - `src/types/runConfig.ts`
   - Templates para linguagens comuns
   - Configurações personalizáveis

2. **Execution Service**
   - `src/services/executionService.ts`
   - Detecção automática de linguagem
   - Integração com terminal

3. **UI Controls**
   - Botão Run no editor
   - Output panel no terminal
   - Status indicators

4. **Comandos Tauri**
   - `run_file`
   - `compile_and_run`
   - Process management

---

## 🐛 FASE 4: Depurador Básico (IMPORTANTE)
**Branch**: `feature/basic-debugger`
**Duração**: 5-6 dias

### Tarefas:
1. **DAP Client Setup**
   - Instalar vscode-debugadapter-node
   - Configurar debug adapters

2. **Debug UI Components**
   - Variables panel
   - Call stack
   - Breakpoints gutter

3. **Debug Service**
   - `src/services/debugService.ts`
   - DAP communication
   - Session management

4. **Monaco Integration**
   - Breakpoint decorations
   - Debug hover
   - Step through code

---

## 🔌 FASE 5: Sistema de Plugins (IMPORTANTE)
**Branch**: `feature/plugin-system`
**Duração**: 4-5 dias

### Tarefas:
1. **Plugin Architecture**
   - Plugin manifest schema
   - Loading mechanism
   - API interface

2. **Plugin Manager**
   - `src/services/pluginService.ts`
   - Install/uninstall
   - Enable/disable

3. **Extension API**
   - Hooks for editor
   - Command registration
   - UI extension points

4. **Sample Plugins**
   - Theme plugin
   - Snippet plugin
   - Language support

---

## ⌨️ FASE 6: Atalhos Avançados (DESEJÁVEL)
**Branch**: `feature/advanced-shortcuts`
**Duração**: 2 dias

### Tarefas:
1. **Expandir useKeyboardShortcuts**
   - Command palette (Ctrl+Shift+P)
   - Quick file open (Ctrl+P)
   - Multi-cursor (Ctrl+D)

2. **Settings Integration**
   - Customizable shortcuts
   - Keybinding UI

---

## 📅 Cronograma Total: ~3-4 semanas

| Fase | Duração | Criticidade | Dependências |
|------|---------|-------------|--------------|
| Fase 1: Terminal | 3-4 dias | ⚠️ CRÍTICO | Nenhuma |
| Fase 2: Busca Global | 2-3 dias | ⚠️ CRÍTICO | Nenhuma |
| Fase 3: Execução | 3-4 dias | ⚠️ CRÍTICO | Fase 1 (Terminal) |
| Fase 4: Debugger | 5-6 dias | 🔶 IMPORTANTE | Fase 1, 3 |
| Fase 5: Plugins | 4-5 dias | 🔶 IMPORTANTE | Nenhuma |
| Fase 6: Atalhos | 2 dias | ◻️ DESEJÁVEL | Nenhuma |

---

## 🛠️ Stack Técnico por Fase

### Terminal (Fase 1)
- **Frontend**: xterm.js + React
- **Backend**: Tauri shell commands
- **Estado**: Zustand terminal store

### Busca (Fase 2) 
- **Frontend**: Expansão do SearchPanel existente
- **Backend**: ripgrep via Tauri
- **Performance**: Web Workers para parsing

### Execução (Fase 3)
- **Frontend**: UI controls + output
- **Backend**: Process spawning via Tauri
- **Integração**: Terminal + Monaco

### Debug (Fase 4)
- **Frontend**: Debug UI components
- **Backend**: DAP servers via Tauri
- **Protocolo**: Debug Adapter Protocol

### Plugins (Fase 5)
- **Frontend**: Plugin manager UI
- **Backend**: Plugin loading via Tauri
- **Segurança**: Sandboxed execution

---

## 🎯 Critérios de Sucesso

### Fase 1 - Terminal ✅
- [ ] Executar comandos shell básicos
- [ ] Output colorido funcionando
- [ ] Resize responsivo
- [ ] Kill processes

### Fase 2 - Busca ✅
- [ ] Busca em todo projeto < 1s
- [ ] Regex support
- [ ] Navegação para resultados
- [ ] Cancelar busca

### Fase 3 - Execução ✅
- [ ] Run Python/JS/TS files
- [ ] Output no terminal
- [ ] Error highlighting
- [ ] Process management

### Fase 4 - Debug ✅
- [ ] Set/remove breakpoints
- [ ] Step through code
- [ ] Inspect variables
- [ ] Call stack view

### Fase 5 - Plugins ✅
- [ ] Load/unload plugins
- [ ] Plugin manifest
- [ ] Extension API
- [ ] Sample plugin working

### Fase 6 - Atalhos ✅
- [ ] Command palette (Ctrl+Shift+P)
- [ ] Quick open (Ctrl+P)
- [ ] Multi-cursor (Ctrl+D)
- [ ] Customizable shortcuts

---

> 💡 **Estratégia**: Implementar fases 1-3 primeiro para ter uma IDE funcional básica, depois adicionar funcionalidades avançadas nas fases 4-6.

> 🚀 **Meta**: Transformar o ToqueMedia Studio em uma IDE profissional completa!