# Patch: Project Creation Flow + Tool Permission System

> **Destino:** Claude Code  
> **Projecto:** `exodus-ide/` (IDE)  
> **Pré-requisito:** Patch anterior (refactor auth/model) aplicado  
> **Objectivo:**
> 1. Definir o flow de criação de projecto (user escolhe pasta primeiro, depois prompt)
> 2. Implementar sistema de permissões para tool calls do agente (Sim / Sim para tudo / Não)

---

## Parte 1 — Flow de Criação de Projecto

### Estado actual

O user abre a app → LoginScreen → WelcomeScreen (escolhe pasta ou projecto recente) → MainLayout com projecto aberto. O agente executa tools na pasta do projecto (`projectStore.currentProject.path`).

Não existe flow para criar projecto novo a partir do chat.

### Novo flow

```
1. User está no WelcomeScreen (ou MainLayout sem projecto)
2. User clica "New Project"
3. Dialog nativo do OS (Tauri file dialog): "Escolhe onde guardar o projecto"
4. User seleciona ou cria pasta (ex: ~/Projects/meu-projecto/)
5. projectStore.setCurrentProject(path)
6. IDE abre ChatView com essa pasta como working directory
7. Chat mostra empty state: "Descreve o projecto que queres criar..."
8. User escreve prompt (ex: "Cria um projecto React com auth e dashboard")
9. Agente executa tools nessa pasta
```

### 1.1 Actualizar WelcomeScreen

**Ficheiro:** `src/components/WelcomeScreen.tsx` (ou equivalente)

**Adicionar botão:** "New Project" ao lado de "Open Project"

**Comportamento de "New Project":**

```typescript
import { open } from '@tauri-apps/plugin-dialog'

async function handleNewProject() {
  // Dialog nativo para selecionar/criar pasta
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Choose a folder for your new project'
  })

  if (selected) {
    // Definir como projecto actual
    projectStore.setCurrentProject(selected as string)
    // Criar nova sessão de chat
    chatStore.createNewSession(selected as string)
    // Navegar para MainLayout → ChatView
  }
}
```

**UI:**

```
┌─────────────────────────────────────────────┐
│         ToqueMedia Studio                   │
│                                             │
│    [📁 Open Project]  [✨ New Project]      │
│                                             │
│    Recent Projects:                         │
│    • ~/Projects/meu-app                     │
│    • ~/Projects/outro-app                   │
│                                             │
└─────────────────────────────────────────────┘
```

### 1.2 Verificar plugin dialog do Tauri

**Ficheiro:** `src-tauri/Cargo.toml`

Verificar se `tauri-plugin-dialog` está nas dependencies. Se não:

```toml
[dependencies]
tauri-plugin-dialog = "2"
```

E registar no `src-tauri/src/lib.rs` ou `main.rs`:

```rust
.plugin(tauri_plugin_dialog::init())
```

**Ficheiro:** `package.json`

```bash
npm install @tauri-apps/plugin-dialog
```

### 1.3 Actualizar ChatView — empty state para novo projecto

**Ficheiro:** `src/components/views/ChatView.tsx`

**Quando:** Sessão nova com 0 mensagens num projecto recém-criado.

**Mostrar:** Empty state orientado para criação.

```
┌─────────────────────────────────────────────┐
│                                             │
│          What do you want to build?         │
│                                             │
│    📁 ~/Projects/meu-projecto               │
│                                             │
│    Suggestions:                             │
│    [React + TypeScript app]                 │
│    [REST API with Express]                  │
│    [Full-stack Next.js app]                 │
│                                             │
│    ┌─────────────────────────────────┐      │
│    │ Describe your project...        │      │
│    └─────────────────────────────────┘      │
└─────────────────────────────────────────────┘
```

As suggestion chips são clicáveis e preenchem o prompt input.

---

## Parte 2 — Tool Permission System

### Conceito

Quando o agente quer executar uma tool que modifica o filesystem (write, create, delete, rename, execute), a IDE pede autorização ao user. O user tem 3 opções:

- **Sim** — autoriza esta tool call específica
- **Sim, para tudo** — autoriza esta e todas as futuras tool calls nesta sessão (auto-approve)
- **Não** — rejeita esta tool call, o agente recebe o resultado "Permission denied" e adapta-se

### 2.1 Classificar tools por risco

**Ficheiro:** `src/services/agent/toolExecutor.ts`

Definir quais tools precisam de permissão:

```typescript
// Tools que NUNCA pedem permissão (read-only)
const SAFE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files'
])

// Tools que PEDEM permissão (modificam filesystem)
const REQUIRES_PERMISSION = new Set([
  'write_file',
  'create_file',
  'create_directory',
  'delete_file',
  'rename_file',
  'execute_command'
])
```

### 2.2 Criar PermissionDialog component

**Ficheiro:** `src/components/chat/PermissionDialog.tsx`

**UI — renderizado inline no chat, não como modal:**

```
┌─────────────────────────────────────────────┐
│ 🔧 The agent wants to:                     │
│                                             │
│    write_file                               │
│    src/components/Login.tsx                  │
│                                             │
│    Preview:                                 │
│    ┌─────────────────────────────────┐      │
│    │ import React from 'react'       │      │
│    │ export function Login() {       │      │
│    │   return (                      │      │
│    │     ...                         │      │
│    │   )                             │      │
│    │ }                               │      │
│    └─────────────────────────────────┘      │
│                                             │
│   [Yes]  [Yes, for all]  [No]              │
└─────────────────────────────────────────────┘
```

**Props:**

```typescript
interface PermissionDialogProps {
  toolName: string
  args: Record<string, unknown>
  onApprove: () => void
  onApproveAll: () => void
  onDeny: () => void
}
```

**Preview por tipo de tool:**
- `write_file` / `create_file` → mostra path + primeiras 20 linhas do conteúdo
- `delete_file` → mostra path em vermelho
- `rename_file` → mostra path antigo → path novo
- `create_directory` → mostra path
- `execute_command` → mostra o comando completo (⚠️ destaque visual — comandos são perigosos)

### 2.3 Criar permission store

**Ficheiro:** `src/stores/permissionStore.ts`

```typescript
interface PermissionState {
  autoApproveAll: boolean              // "Sim, para tudo" foi clicado
  pendingPermission: PendingPermission | null  // tool call à espera de decisão
}

interface PendingPermission {
  id: string
  toolName: string
  args: Record<string, unknown>
  resolve: (approved: boolean) => void  // Promise resolver
}

interface PermissionActions {
  requestPermission: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  approve: () => void
  approveAll: () => void
  deny: () => void
  resetAutoApprove: () => void         // Reset no início de cada sessão nova
}
```

**Implementação de `requestPermission`:**

```typescript
requestPermission: (toolName, args) => {
  const state = get()

  // Se auto-approve está activo, aprovar imediatamente
  if (state.autoApproveAll) {
    return Promise.resolve(true)
  }

  // Se é tool safe, aprovar imediatamente
  if (SAFE_TOOLS.has(toolName)) {
    return Promise.resolve(true)
  }

  // Senão, criar Promise e esperar decisão do user
  return new Promise<boolean>((resolve) => {
    set({
      pendingPermission: {
        id: crypto.randomUUID(),
        toolName,
        args,
        resolve
      }
    })
  })
}
```

**`approve()`:**
```typescript
approve: () => {
  const { pendingPermission } = get()
  if (pendingPermission) {
    pendingPermission.resolve(true)
    set({ pendingPermission: null })
  }
}
```

**`approveAll()`:**
```typescript
approveAll: () => {
  const { pendingPermission } = get()
  if (pendingPermission) {
    pendingPermission.resolve(true)
    set({ pendingPermission: null, autoApproveAll: true })
  }
}
```

**`deny()`:**
```typescript
deny: () => {
  const { pendingPermission } = get()
  if (pendingPermission) {
    pendingPermission.resolve(false)
    set({ pendingPermission: null })
  }
}
```

### 2.4 Integrar no toolExecutor.ts

**Ficheiro:** `src/services/agent/toolExecutor.ts`

**Onde:** Antes de executar qualquer tool, verificar permissão.

**Actualmente** (pseudo-código):
```typescript
async executeTool(name: string, args: Record<string, unknown>) {
  // Executa directamente
  const result = await invoke(tauriCommand, args)
  return result
}
```

**Depois:**
```typescript
async executeTool(name: string, args: Record<string, unknown>) {
  // 1. Pedir permissão
  const permissionStore = usePermissionStore.getState()
  const approved = await permissionStore.requestPermission(name, args)

  if (!approved) {
    // Retornar resultado de "denied" ao agente
    // O agente recebe isto como tool result e adapta-se
    return {
      success: false,
      error: 'Permission denied by user'
    }
  }

  // 2. Executar
  const result = await invoke(tauriCommand, args)
  return result
}
```

**IMPORTANTE:** Quando o user clica "Não", o agentic loop NÃO pára. O resultado "Permission denied" é enviado de volta ao LLM como tool_result. O LLM vê que a permissão foi negada e decide o que fazer (pode pedir de outra forma, pode continuar com outra tool, ou pode parar).

### 2.5 Renderizar PermissionDialog no ChatPanel

**Ficheiro:** `src/components/chat/ChatPanel.tsx` (ou `ChatView.tsx`)

**Onde:** Acima do PromptBar, quando `permissionStore.pendingPermission` não é null.

```typescript
const { pendingPermission } = usePermissionStore()

return (
  <Flex direction="column" flex="1">
    <MessageList ... />

    {pendingPermission && (
      <PermissionDialog
        toolName={pendingPermission.toolName}
        args={pendingPermission.args}
        onApprove={() => permissionStore.approve()}
        onApproveAll={() => permissionStore.approveAll()}
        onDeny={() => permissionStore.deny()}
      />
    )}

    <PromptBar ... />
  </Flex>
)
```

**Enquanto há pendingPermission:**
- O PromptBar fica disabled (não pode enviar novo prompt)
- O agente está "pausado" à espera do tool_result
- O status no AgentStatusBar mostra: "Awaiting permission..."

### 2.6 Reset auto-approve por sessão

**Quando o user inicia uma nova sessão de chat** (novo chat ou troca de sessão):

```typescript
// Em chatStore.createNewSession ou chatStore.switchSession:
usePermissionStore.getState().resetAutoApprove()
```

Isto garante que "Sim, para tudo" não persiste entre sessões. Cada sessão nova começa a pedir permissão.

### 2.7 Keyboard shortcuts

- `Enter` ou `Y` → Sim
- `Shift+Enter` ou `A` → Sim, para tudo
- `Escape` ou `N` → Não

Adicionar event listener quando `pendingPermission` está activo.

---

## Critérios de Done

### Project Creation:
- [ ] Botão "New Project" no WelcomeScreen
- [ ] Dialog nativo do OS para selecionar pasta
- [ ] Pasta seleccionada define-se como projecto actual
- [ ] ChatView abre com empty state orientado para criação
- [ ] Suggestion chips funcionais e preenchem o prompt

### Tool Permissions:
- [ ] Tools read-only (`read_file`, `list_directory`, `search_files`) executam sem pedir
- [ ] Tools de escrita (`write_file`, `create_file`, `delete_file`, `rename_file`, `create_directory`, `execute_command`) pedem permissão
- [ ] PermissionDialog renderiza inline no chat com preview da operação
- [ ] "Sim" — aprova esta tool call, próxima pede de novo
- [ ] "Sim, para tudo" — aprova todas as tool calls restantes na sessão
- [ ] "Não" — envia "Permission denied" ao LLM, loop continua
- [ ] Auto-approve reseta ao criar/trocar sessão
- [ ] PromptBar desabilitado enquanto aguarda permissão
- [ ] AgentStatusBar mostra "Awaiting permission..."
- [ ] Keyboard shortcuts funcionam (Y/A/N ou Enter/Shift+Enter/Escape)
- [ ] `npm run build` sem erros

---

## O que NÃO fazer

- Não implementar permissões granulares por tipo de ficheiro (ex: ".env não pode ser escrito")
- Não implementar permissões persistentes entre sessões (sempre reset)
- Não modificar o Worker
- Não modificar o agentic loop — só o toolExecutor que é o ponto de intercepção
- Não bloquear tools safe (read-only) com permissões
- Não implementar "Não, para tudo" (não há use case — se o user quer parar, cancela o stream)
