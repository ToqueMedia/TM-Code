# ToqueMedia Studio — AI-First Pivot
## Spec de Execução: Fase 0 (Limpeza) + Fase 1 (Chat Panel + Streaming)

> **Destino:** Claude Code
> **Projecto:** ToqueMedia Studio (Tauri v2 + React/TypeScript)
> **Contexto:** IDE desktop a ser pivotada de editor tradicional para AI-First. O chat panel é o centro da experiência. O editor de código é secundário/opcional.

---

## FASE 0 — Limpeza e Preparação

### 0.1 Ficheiros a REMOVER

Apagar completamente estes ficheiros:

- `src/components/CodeEditorSimple.tsx`
- `src/components/ui/TerminalV2.tsx`
- `src/stores/fileTreeStore.ts.backup`
- `src/stores/fileTreeStore.ts.restore`

### 0.2 Ficheiros a CONGELAR (não modificar, não apagar)

Estes ficam no projecto mas não recebem trabalho:

- `src/components/DebuggerPanel.tsx`
- `src/services/debuggerService.ts`
- `src-tauri/src/commands/debugger.rs`

### 0.3 Cargo.toml — Remover dapts se não usado

Em `src-tauri/Cargo.toml`, verificar se `dapts = "0.0.6"` é importado em algum ficheiro `.rs`. Se não for, remover a linha:

```toml
# REMOVER se não usado:
dapts = "0.0.6"
```

Fazer `grep -r "dapts" src-tauri/src/` para confirmar.

### 0.4 Criar estrutura de directórios

```bash
mkdir -p src/components/chat
mkdir -p src/services/agent
mkdir -p src/types
```

### 0.5 Criar tipos base

Criar `src/types/agent.ts`:

```typescript
// === Agent Types ===

export type AgentStatus = 'idle' | 'thinking' | 'generating' | 'applying' | 'error'

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type AgentToolName =
  | 'read_file'
  | 'write_file'
  | 'create_file'
  | 'create_directory'
  | 'delete_file'
  | 'list_directory'
  | 'search_files'
  | 'execute_command'

export interface AgentToolCall {
  id: string
  tool: AgentToolName
  args: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: unknown
  error?: string
}

export interface AgentResponse {
  type: 'text' | 'code' | 'tool_call' | 'error' | 'done'
  content?: string
  language?: string
  filePath?: string
  toolCall?: AgentToolCall
}
```

Criar `src/types/chat.ts`:

```typescript
// === Chat Types ===

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  codeBlocks?: CodeBlock[]
  toolCalls?: import('./agent').AgentToolCall[]
  isStreaming?: boolean
}

export interface CodeBlock {
  id: string
  language: string
  code: string
  filePath?: string
  status: 'pending' | 'applied' | 'rejected'
}

export interface ChatSession {
  id: string
  projectPath: string
  messages: ChatMessage[]
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error'
  createdAt: number
  updatedAt: number
}

export interface SessionContext {
  files: string[]
  fileTreeSummary: string
  projectType: string
  activeFile: string | null
  customInstructions?: string
}
```

### 0.6 Critérios de Done — Fase 0

- [ ] Os 4 ficheiros listados em 0.1 foram apagados
- [ ] `dapts` removido do Cargo.toml (se confirmado não usado)
- [ ] Directórios `src/components/chat/`, `src/services/agent/` existem
- [ ] `src/types/agent.ts` e `src/types/chat.ts` existem e compilam sem erros
- [ ] `cargo build` passa sem erros
- [ ] `npm run build` (ou equivalente vite build) passa sem erros
- [ ] Nenhuma funcionalidade existente foi quebrada

---

## FASE 1 — Chat Panel + Streaming

### Objectivo

User escreve prompt → request vai ao backend Cloudflare → resposta streama de volta → texto e code blocks aparecem no chat.

### 1.1 agentService.ts

Criar `src/services/agent/agentService.ts`:

**Responsabilidade:** Comunicação SSE com o backend Cloudflare Worker.

```typescript
// === Interface pública do service ===

interface AgentServiceConfig {
  baseUrl: string       // URL do Worker (ex: https://studio-api.toquemedia.workers.dev)
  apiKey?: string       // Auth token do user (futuro)
}

interface SendMessageOptions {
  prompt: string
  context: import('../../types/chat').SessionContext
  sessionId: string
  model?: string        // default: 'claude-sonnet'
}

interface AgentServiceCallbacks {
  onToken: (token: string) => void
  onCodeBlock: (block: import('../../types/chat').CodeBlock) => void
  onToolCall: (call: import('../../types/agent').AgentToolCall) => void
  onDone: () => void
  onError: (error: Error) => void
}
```

**Implementação:**

- Usar `fetch()` com `Accept: text/event-stream` para SSE
- Parsing de eventos SSE manual (não usar EventSource — não suporta POST com body)
- Cada evento SSE tem formato: `data: {"type": "text|code|tool_call|done|error", ...}\n\n`
- Stream tokens para `onToken` callback
- Quando detecta code block completo (delimitado por ` ```language\n...``` `), emite `onCodeBlock`
- `AbortController` para cancelar stream
- Expor método `cancelStream()` para o user poder parar

**Pattern de SSE parsing:**

```typescript
const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
  signal: abortController.signal
})

const reader = response.body!.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  
  buffer += decoder.decode(value, { stream: true })
  
  // Parse SSE events from buffer
  const lines = buffer.split('\n')
  buffer = lines.pop() || ''
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6))
      // route to callbacks based on data.type
    }
  }
}
```

### 1.2 chatStore.ts

Criar `src/stores/chatStore.ts`:

**Estado:**

```typescript
interface ChatState {
  sessions: Map<string, import('../types/chat').ChatSession>
  activeSessionId: string | null
  isStreaming: boolean
  streamingMessageId: string | null
  error: string | null
}
```

**Actions:**

```typescript
interface ChatActions {
  // Session management
  createSession: (projectPath: string) => string  // returns sessionId
  getActiveSession: () => import('../types/chat').ChatSession | null
  setActiveSession: (sessionId: string) => void
  
  // Messages
  addUserMessage: (content: string) => string  // returns messageId
  startAssistantMessage: () => string          // returns messageId, sets isStreaming=true
  appendToAssistantMessage: (token: string) => void
  finalizeAssistantMessage: () => void         // sets isStreaming=false
  addCodeBlockToMessage: (messageId: string, block: import('../types/chat').CodeBlock) => void
  
  // Code block actions
  updateCodeBlockStatus: (messageId: string, blockId: string, status: 'applied' | 'rejected') => void
  
  // Stream control
  setStreaming: (streaming: boolean) => void
  setError: (error: string | null) => void
  
  // Cleanup
  clearSession: (sessionId: string) => void
}
```

**Implementação:** Zustand store, sem persist por agora (persist vem na Fase 6).

### 1.3 agentStore.ts

Criar `src/stores/agentStore.ts`:

```typescript
interface AgentState {
  status: import('../types/agent').AgentStatus
  currentModel: string
  availableModels: string[]
  error: string | null
}

interface AgentActions {
  setStatus: (status: import('../types/agent').AgentStatus) => void
  setModel: (model: string) => void
  setError: (error: string | null) => void
  reset: () => void
}
```

**Modelos disponíveis (hardcoded por agora):**

```typescript
availableModels: ['claude-sonnet', 'claude-opus', 'gemini-flash', 'gemini-pro']
```

### 1.4 ChatPanel.tsx

Criar `src/components/chat/ChatPanel.tsx`:

**Responsabilidade:** Panel principal que mostra o histórico de mensagens e streaming.

**Estrutura:**

```
ChatPanel
├── MessageList (scroll area com mensagens)
│   └── MessageBubble (por cada mensagem)
│       └── CodeBlockAction (por cada code block)
├── AgentStatusBar (estado do agente: idle, thinking, etc.)
└── PromptInput (input fixo no fundo)
```

**Props:** Nenhuma — usa stores directamente.

**Comportamento:**
- Auto-scroll para o fundo quando nova mensagem/token chega
- Scroll area com virtualização se necessário (pode começar sem)
- Quando `isStreaming === true`, a última mensagem do assistant anima com cursor pulsante
- Background: usar tokens do tema existente (`bg.sidebar` ou similar)

**Dimensões:** Ocupa a coluna central/esquerda do layout. Mínimo 400px de largura.

### 1.5 MessageBubble.tsx

Criar `src/components/chat/MessageBubble.tsx`:

**Props:**

```typescript
interface MessageBubbleProps {
  message: import('../../types/chat').ChatMessage
  isStreaming?: boolean
}
```

**Comportamento:**
- Mensagens do user: alinhadas à direita, fundo `#1a3a5c` (ou similar ao tema)
- Mensagens do assistant: alinhadas à esquerda, fundo `#2d2d30`
- Parsing de markdown no conteúdo (usar uma lib leve tipo `react-markdown` — verificar se já está nas dependencies, se não, instalar)
- Code blocks dentro do markdown renderizados com syntax highlighting (usar `react-syntax-highlighter` ou reusar o tema Monaco existente)
- Cada code block emite um `CodeBlockAction` por baixo

### 1.6 CodeBlockAction.tsx

Criar `src/components/chat/CodeBlockAction.tsx`:

**Props:**

```typescript
interface CodeBlockActionProps {
  block: import('../../types/chat').CodeBlock
  messageId: string
  onApply: (block: CodeBlock) => void
  onReject: (block: CodeBlock) => void
  onCopy: (code: string) => void
}
```

**UI:**
- Barra por cima do code block com: nome do ficheiro (se `filePath` existe), linguagem
- Barra por baixo com botões: `Apply` (verde), `Reject` (vermelho), `Copy` (neutro)
- Estado visual: pending (botões activos), applied (verde, botões disabled), rejected (vermelho strikethrough)

**Nota:** Na Fase 1, `Apply` apenas copia para clipboard e marca como applied. A aplicação real no filesystem é Fase 3.

### 1.7 AgentStatusBar.tsx

Criar `src/components/chat/AgentStatusBar.tsx`:

**Comportamento:**
- Lê `agentStore.status`
- Mostra indicador visual:
  - `idle`: ponto cinza + "Ready"
  - `thinking`: ponto amarelo pulsante + "Thinking..."
  - `generating`: ponto azul pulsante + "Generating..."
  - `applying`: ponto verde pulsante + "Applying changes..."
  - `error`: ponto vermelho + mensagem de erro
- Quando `isStreaming`, mostra botão "Stop" que chama `agentService.cancelStream()`

### 1.8 PromptInput.tsx

Criar `src/components/chat/PromptInput.tsx`:

**UI:**
- Textarea expansível (min 1 linha, max 6 linhas, depois scroll)
- Botão Send (ou Cmd+Enter)
- Placeholder: "Ask the agent to help with your code..."
- Disabled quando `isStreaming === true`
- Futuro: botões de attach files e model selector (Fase 2). Por agora, placeholder/disabled.

**Comportamento no Send:**

```typescript
async function handleSend(prompt: string) {
  const chatStore = useChatStore.getState()
  const agentStore = useAgentStore.getState()
  
  // 1. Add user message
  chatStore.addUserMessage(prompt)
  
  // 2. Start assistant message
  const messageId = chatStore.startAssistantMessage()
  agentStore.setStatus('thinking')
  
  // 3. Build minimal context (Fase 1: apenas projectPath + fileTree summary)
  const context = { /* minimal */ }
  
  // 4. Call agentService
  await agentService.sendMessage({
    prompt,
    context,
    sessionId: chatStore.activeSessionId!,
  }, {
    onToken: (token) => {
      agentStore.setStatus('generating')
      chatStore.appendToAssistantMessage(token)
    },
    onCodeBlock: (block) => {
      chatStore.addCodeBlockToMessage(messageId, block)
    },
    onDone: () => {
      chatStore.finalizeAssistantMessage()
      agentStore.setStatus('idle')
    },
    onError: (error) => {
      agentStore.setStatus('error')
      agentStore.setError(error.message)
      chatStore.finalizeAssistantMessage()
    }
  })
}
```

### 1.9 Layout — Integração no CodeEditorNew.tsx

**MODIFICAR** `src/components/CodeEditorNew.tsx` (não criar novo):

**Mudanças necessárias:**

1. Importar `ChatPanel` de `./chat/ChatPanel`

2. Na área principal (dentro de `{/* Editor Area */}`), substituir o layout para:

```
<Flex flex="1" overflow="hidden">
  {/* Chat Panel — coluna principal */}
  <ChatPanel />  {/* flex: 1, minW: 400px */}
  
  {/* Editor Panel — coluna secundária, toggle via ActivityBar */}
  {showEditor && (
    <Flex flex="1" direction="column">
      <EditorTabs ... />
      <Breadcrumbs ... />
      <MonacoEditor ... />
    </Flex>
  )}
</Flex>
```

3. Adicionar nova activity no `ActivityBar`: `chat` (ícone: `FiMessageSquare` do react-icons). Esta activity mostra/esconde o chat panel.

4. O estado `showEditor` é true quando há ficheiros abertos E o user activou a activity de editor. Default: chat visível, editor escondido.

5. O ActivityBar ganha dois novos items:
   - `chat` (FiMessageSquare) — toggle do chat panel (default: ON)
   - `editor` (FiCode) — toggle do editor panel (default: OFF, liga quando user abre ficheiro)

### 1.10 Backend — Worker Mínimo (Cloudflare)

Este NÃO é para o CC executar no projecto Tauri. É um projecto separado.

Mas para que a Fase 1 funcione end-to-end, o CC pode criar um **mock server local** que simula o Worker:

Criar `src/services/agent/mockServer.ts` (usado em dev):

```typescript
// Mock SSE server para desenvolvimento
// Simula respostas do Worker sem precisar de Cloudflare deployed

export function createMockResponse(prompt: string): ReadableStream {
  // Gera uma resposta fake com tokens individuais streamed
  // Inclui pelo menos um code block na resposta
  // Simula latência de 30-50ms entre tokens
}
```

O `agentService.ts` deve ter um flag `USE_MOCK = true` que pode ser toggled. Quando `USE_MOCK`, usa o mock local. Quando `false`, chama o Worker real.

### 1.11 Dependências a instalar

```bash
npm install react-markdown react-syntax-highlighter
npm install -D @types/react-syntax-highlighter
```

Verificar se `uuid` já está nas deps do frontend (está no Rust mas pode não estar no TS). Se não, instalar.

### 1.12 Critérios de Done — Fase 1

- [ ] `src/services/agent/agentService.ts` existe e exporta `sendMessage()` e `cancelStream()`
- [ ] `src/stores/chatStore.ts` existe com todas as actions listadas
- [ ] `src/stores/agentStore.ts` existe
- [ ] `src/components/chat/ChatPanel.tsx` renderiza mensagens
- [ ] `src/components/chat/MessageBubble.tsx` renderiza markdown + code blocks
- [ ] `src/components/chat/CodeBlockAction.tsx` mostra botões Apply/Reject/Copy
- [ ] `src/components/chat/AgentStatusBar.tsx` mostra estado do agente
- [ ] `src/components/chat/PromptInput.tsx` aceita input e dispatcha para agentService
- [ ] `CodeEditorNew.tsx` mostra ChatPanel como coluna principal
- [ ] ActivityBar tem items `chat` e `editor`
- [ ] Mock server funciona: user escreve prompt → resposta streama com tokens → code blocks aparecem
- [ ] Botão "Stop" cancela o stream
- [ ] Botão "Copy" copia code block para clipboard
- [ ] `npm run build` passa sem erros
- [ ] `cargo tauri dev` abre a app com o novo layout

---

## Notas para o Claude Code

### Convenções do projecto existente (respeitar):

- **Stores:** Zustand com pattern `create<State & Actions>()` — ver `editorStore.ts` como referência
- **Components:** Functional components com memo quando apropriado, Chakra UI para styling
- **Services:** Singleton pattern com `getInstance()` — ver `debuggerService.ts` como referência
- **Nomes de ficheiros:** camelCase para services/utils, PascalCase para components
- **Imports:** Path relativo, não aliases
- **Temas/cores:** Usar tokens existentes do tema quando possível (`bg.sidebar`, `bg.editor`, `text.primary`, `text.muted`, `border.glass`). Para cores novas do chat, seguir o padrão dark existente (#1e1e1e, #2d2d30, #252526)
- **React Icons:** já usa `react-icons/fi` (Feather Icons) — manter consistência

### O que NÃO fazer:

- Não modificar o backend Rust (excepto remover dapts se confirmado)
- Não tocar no DebuggerPanel ou debugger.rs
- Não reestruturar stores existentes (editorStore, projectStore, fileTreeStore)
- Não mudar o tema Monaco
- Não remover funcionalidades existentes (file tree, terminal, search continuam a funcionar)
- Não adicionar rotas ou páginas novas — é single page
