# Patch: Slash Commands + TMS.md (Project Memory)

> **Destino:** Claude Code  
> **Projecto:** `exodus-ide/` (IDE)  
> **Pré-requisito:** Skills system implementado  
> **Objectivo:** Sistema de slash commands no PromptBar + /init (TMS.md + memória persistente) + /plan (architect → specs → approval → todo list) + /payments (stub para futuro).

---

## Conceito

### Slash Commands

O user escreve `/` no PromptBar e vê um autocomplete com comandos disponíveis:

```
┌──────────────────────────────────────────────────────────────────┐
│ /init       Initialize project — analyze and generate TMS.md    │
│ /plan       Architect a feature — specs, design, approval, todo │
│ /payments   Load MoMenu payment skills                          │
└──────────────────────────────────────────────────────────────────┘
│ Describe what you want to build...                               │
└──────────────────────────────────────────────────────────────────┘
```

### TMS.md — Mais que um CLAUDE.md

O CLAUDE.md do CC é estático — instruções para o agente. O TMS.md vai além:

```
TMS.md
├── Project Analysis (auto-gerado pelo /init)
│   ├── Framework, linguagem, estrutura
│   ├── Comandos de build/test/lint
│   └── Convenções detectadas
│
├── Memory (actualizado pelo agente durante o trabalho)
│   ├── Milestones completados
│   ├── Decisões arquitecturais tomadas
│   └── Tarefas pendentes
│
└── Custom Instructions (editável pelo dev)
    └── Regras adicionais, preferências
```

O agente lê o TMS.md no início de cada sessão E actualiza-o ao longo do trabalho.

---

## 1. Slash Command System

### 1.1 Criar slashCommandRegistry.ts

**Criar:** `src/services/agent/slashCommandRegistry.ts`

```typescript
interface SlashCommand {
  name: string              // "/init"
  description: string       // "Initialize project analysis"
  enabled: boolean          // true = funcional, false = stub
  execute: (args: string, projectPath: string) => Promise<void>
}

class SlashCommandRegistry {
  private static instance: SlashCommandRegistry
  private commands: Map<string, SlashCommand> = new Map()

  static getInstance(): SlashCommandRegistry {
    if (!SlashCommandRegistry.instance) {
      SlashCommandRegistry.instance = new SlashCommandRegistry()
      SlashCommandRegistry.instance.registerDefaults()
    }
    return SlashCommandRegistry.instance
  }

  // Registar comandos default
  private registerDefaults(): void {
    this.register({
      name: '/init',
      description: 'Initialize project — analyze structure, detect framework, generate TMS.md',
      enabled: true,
      execute: executeInit
    })

    this.register({
      name: '/plan',
      description: 'Architect a feature — generate specs, get approval, create dev todo list',
      enabled: true,
      execute: executePlan
    })

    this.register({
      name: '/payments',
      description: 'Load MoMenu payment skills (Multicaixa, E-kwanza, Referência)',
      enabled: false,  // STUB — não implementado
      execute: executePaymentsStub
    })
  }

  register(command: SlashCommand): void {
    this.commands.set(command.name, command)
  }

  // Verificar se input é um slash command
  isSlashCommand(input: string): boolean {
    const cmd = input.trim().split(' ')[0]
    return this.commands.has(cmd)
  }

  // Obter comando
  getCommand(input: string): SlashCommand | null {
    const cmd = input.trim().split(' ')[0]
    return this.commands.get(cmd) || null
  }

  // Extrair argumentos após o comando
  getArgs(input: string): string {
    const parts = input.trim().split(' ')
    return parts.slice(1).join(' ')
  }

  // Listar comandos para autocomplete
  listCommands(): SlashCommand[] {
    return Array.from(this.commands.values())
  }

  // Filtrar comandos por prefixo (para autocomplete)
  filterCommands(prefix: string): SlashCommand[] {
    return this.listCommands().filter(cmd =>
      cmd.name.startsWith(prefix.toLowerCase())
    )
  }
}

export const slashCommandRegistry = SlashCommandRegistry.getInstance()
```

### 1.2 Actualizar PromptBar — autocomplete

**Ficheiro:** `src/components/PromptBar.tsx`

**Adicionar:** Autocomplete dropdown quando o user escreve `/`.

```typescript
function PromptBar() {
  const [input, setInput] = useState('')
  const [showCommandMenu, setShowCommandMenu] = useState(false)
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([])

  function handleInputChange(value: string) {
    setInput(value)

    // Detectar slash command
    if (value.startsWith('/')) {
      const commands = slashCommandRegistry.filterCommands(value)
      setFilteredCommands(commands)
      setShowCommandMenu(commands.length > 0)
    } else {
      setShowCommandMenu(false)
    }
  }

  async function handleSend(prompt: string) {
    // Verificar se é slash command
    if (slashCommandRegistry.isSlashCommand(prompt)) {
      const command = slashCommandRegistry.getCommand(prompt)
      if (!command) return

      if (!command.enabled) {
        chatStore.addSystemMessage(`⚠️ Command ${command.name} is not yet available.`)
        return
      }

      const args = slashCommandRegistry.getArgs(prompt)
      const projectPath = projectStore.currentProject?.path

      if (!projectPath) {
        chatStore.addSystemMessage('❌ No project open. Open a project first.')
        return
      }

      setInput('')
      await command.execute(args, projectPath)
      return
    }

    // Prompt normal — agentic loop
    // ... código existente ...
  }

  function handleCommandSelect(command: SlashCommand) {
    setInput(command.name + ' ')
    setShowCommandMenu(false)
    // Focus no input
  }

  return (
    <Box position="relative">
      {/* Command autocomplete dropdown */}
      {showCommandMenu && (
        <Box
          position="absolute"
          bottom="100%"
          left={0}
          right={0}
          mb={1}
          bg="bg.elevated"
          borderRadius="md"
          border="1px solid"
          borderColor="border.default"
          overflow="hidden"
          zIndex={10}
        >
          {filteredCommands.map(cmd => (
            <Flex
              key={cmd.name}
              px={3}
              py={2}
              cursor="pointer"
              _hover={{ bg: 'bg.hover' }}
              onClick={() => handleCommandSelect(cmd)}
              opacity={cmd.enabled ? 1 : 0.5}
              align="center"
              gap={3}
            >
              <Text fontFamily="mono" fontSize="sm" color="text.accent" fontWeight="bold">
                {cmd.name}
              </Text>
              <Text fontSize="xs" color="text.muted">
                {cmd.description}
              </Text>
              {!cmd.enabled && (
                <Badge size="xs" colorScheme="gray">coming soon</Badge>
              )}
            </Flex>
          ))}
        </Box>
      )}

      {/* Input area */}
      <Textarea
        value={input}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe what you want to build... (type / for commands)"
        // ...
      />
    </Box>
  )
}
```

---

## 2. Comando /init — Gerar TMS.md

### 2.1 Implementação de executeInit

**Criar:** `src/services/agent/commands/initCommand.ts`

```typescript
import { invoke } from '@tauri-apps/api/core'
import { useChatStore } from '../../../stores/chatStore'

export async function executeInit(args: string, projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()
  const agentStore = useAgentStore.getState()

  // 1. Verificar se TMS.md já existe
  const tmsPath = `${projectPath}/TMS.md`
  let existingTms: string | null = null

  try {
    existingTms = await invoke<string>('read_file', { path: tmsPath })
  } catch {
    // Não existe — normal
  }

  if (existingTms) {
    chatStore.addSystemMessage(
      '📋 TMS.md already exists. The agent will update it with fresh analysis.'
    )
  } else {
    chatStore.addSystemMessage(
      '🔍 Analyzing project to generate TMS.md...'
    )
  }

  // 2. Dar ao agente um prompt especial de /init
  // O agente analisa o projecto e gera/actualiza o TMS.md
  const initPrompt = buildInitPrompt(projectPath, existingTms)

  // 3. Executar via agentic loop normal
  // O agente vai usar read_file, list_directory, etc. para analisar
  // e depois write_file para criar/actualizar TMS.md
  chatStore.addUserMessage('/init')
  const messageId = chatStore.startAssistantMessage()
  agentStore.setStatus('thinking')

  const agentService = AgentService.getInstance()
  const contextBuilder = ContextBuilder.getInstance()
  const systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, '')

  await agentService.runAgentLoop(
    initPrompt,
    [],  // Conversa limpa para /init
    agentService.getToolDefinitions(),
    {
      // ... callbacks standard (onTextDelta, onToolCallStart, etc.)
      // Mesmos callbacks que o handleSend normal
    }
  )
}

function buildInitPrompt(projectPath: string, existingTms: string | null): string {
  if (existingTms) {
    return `Analyze this project and UPDATE the existing TMS.md file at ${projectPath}/TMS.md.

The current TMS.md content is:
\`\`\`
${existingTms}
\`\`\`

Do the following:
1. Re-analyze the project structure, dependencies, and configuration
2. Update the "Project Analysis" section with any changes
3. PRESERVE the "Memory" section — do NOT overwrite milestones, decisions, or pending tasks
4. PRESERVE the "Custom Instructions" section
5. Write the updated TMS.md

Use tools to read the project files before updating.`
  }

  return `Analyze this project and create a TMS.md file at ${projectPath}/TMS.md.

Use your tools to explore the project:
1. List the directory structure (2 levels deep)
2. Read package.json, tsconfig.json, Cargo.toml, go.mod, requirements.txt — whichever exist
3. Read README.md if it exists
4. Check for existing config files (.eslintrc, .prettierrc, vitest.config, jest.config, etc.)
5. Check for CI/CD configs (.github/workflows/, Dockerfile, etc.)

Then generate TMS.md with this EXACT structure:

\`\`\`markdown
# TMS — Project Memory

> Auto-generated by ToqueMedia Studio. Last updated: {current date}
> This file is read by the AI agent at the start of each session.

---

## Project Analysis

### Overview
- **Name:** {from package.json or folder name}
- **Framework:** {React, Vue, Angular, Next.js, Go, Python, etc.}
- **Language:** {TypeScript, JavaScript, Go, Python, Rust, etc.}
- **Package Manager:** {npm, yarn, pnpm, go modules, pip}
- **Monorepo:** {yes/no}

### Commands
- **Install:** {npm install, go mod download, pip install -r requirements.txt, etc.}
- **Dev:** {npm run dev, go run main.go, python main.py, etc.}
- **Build:** {npm run build, go build, etc.}
- **Test:** {npm test, go test ./..., pytest, etc.}
- **Lint:** {npm run lint, golangci-lint run, etc.}

### Structure
{key directories and their purpose, 2-3 lines each}

### Conventions Detected
{naming patterns, file organization, import style, etc. — inferred from existing code}

### Dependencies (Key)
{list top 5-10 most important dependencies with their purpose}

---

## Memory

### Milestones
{empty — will be filled as work progresses}

### Decisions
{empty — will be filled as architectural decisions are made}

### Pending Tasks
{empty — will be filled as tasks are identified}

---

## Custom Instructions

{empty — developer can add custom rules here}
Add your project-specific instructions below. These will guide the AI agent.

\`\`\`

IMPORTANT:
- Be accurate — only write what you can confirm from the files
- If a command doesn't exist (no test script, no lint script), write "not configured"
- The Memory section MUST start empty
- The Custom Instructions section MUST start with the placeholder text
- Write the file using the write_file tool`
}
```

### 2.2 TMS.md como skill automática

**Ficheiro:** `src/services/agent/contextBuilder.ts`

O contextBuilder já carrega skills. Adicionar: se `TMS.md` existe na raiz do projecto, carregá-lo como skill prioritária.

```typescript
async buildSystemPrompt(projectPath: string, projectType: string): Promise<string> {
  // ... código existente ...

  // Carregar TMS.md se existir (prioridade máxima — carregado por último)
  let tmsBlock = ''
  try {
    const tmsContent = await invoke<string>('read_file', { 
      path: `${projectPath}/TMS.md` 
    })
    tmsBlock = `\n\n## Project Memory (TMS.md)\n\n${tmsContent}`
  } catch {
    // TMS.md não existe — normal
  }

  // Carregar skills (bundled → global → project)
  const skills = await skillService.loadSkills(projectPath, projectType)
  const skillsBlock = skillService.buildSkillsPromptBlock(skills)

  // Ordem no system prompt:
  // 1. Base prompt (instruções do agente)
  // 2. TMS.md (contexto + memória do projecto) ← máxima prioridade
  // 3. Skills (bundled → global → project)
  return `${basePrompt}${tmsBlock}${skillsBlock}`
}
```

### 2.3 Agente actualiza TMS.md automaticamente

O agente deve actualizar a secção "Memory" do TMS.md quando:
- Completa um milestone significativo
- Toma uma decisão arquitectural
- Identifica tarefas pendentes

**Adicionar ao system prompt base** (em contextBuilder):

```typescript
const MEMORY_INSTRUCTIONS = `
## TMS.md Memory Updates
When you complete significant work, update the Memory section of TMS.md:
- Add completed milestones under "### Milestones" with date
- Record architectural decisions under "### Decisions" with rationale
- Track pending tasks under "### Pending Tasks"
- NEVER overwrite the "Project Analysis" or "Custom Instructions" sections
- Use edit_file to surgically update only the Memory section
`
```

---

## 3. Comando /plan — Architect → Specs → Approval → Todo

### 3.1 Conceito

O `/plan` transforma uma ideia vaga do user numa arquitectura completa, pede aprovação, e gera uma lista de tarefas para o agente coder executar.

**Flow completo:**

```
FASE 1 — Entender
  User: "/plan quero uma app de gestão de inventário para a minha loja"
  Agente (Architect role): Faz perguntas de clarificação se necessário
  
FASE 2 — Arquitectar
  Agente analisa projecto existente (TMS.md, estrutura, stack)
  Agente gera PLAN.md com:
    - Arquitectura técnica
    - Specs funcionais (o que cada feature faz)
    - Specs visuais (layouts, componentes UI, fluxos de navegação)
    - Decisões técnicas (libs, patterns, estrutura)
    - Estimativa de complexidade
  
FASE 3 — Aprovar
  Plano apresentado ao user no chat
  User aprova, rejeita, ou pede alterações
  ┌─────────────────────────────────────┐
  │ 📋 Plan Ready for Review           │
  │                                     │
  │ [View Full Plan]                    │
  │                                     │
  │ [✅ Approve]  [✏️ Request Changes]  │
  │ [❌ Reject]                         │
  └─────────────────────────────────────┘
  
FASE 4 — Gerar Todo List
  Após aprovação, agente transforma o plano numa lista de tarefas
  ordenada por dependências, apresentada ao user
  ┌─────────────────────────────────────────┐
  │ 📝 Development Plan (12 tasks)          │
  │                                         │
  │ Phase 1 — Foundation                    │
  │ □ 1. Create database schema             │
  │ □ 2. Setup API routes structure         │
  │ □ 3. Create base UI layout             │
  │                                         │
  │ Phase 2 — Core Features                 │
  │ □ 4. Implement product CRUD            │
  │ □ 5. Implement inventory tracking      │
  │ □ 6. Create dashboard with stats       │
  │ ...                                     │
  │                                         │
  │ [▶️ Start Execution]  [📄 Save Plan]   │
  └─────────────────────────────────────────┘
```

### 3.2 Implementação de executePlan

**Criar:** `src/services/agent/commands/planCommand.ts`

```typescript
import { invoke } from '@tauri-apps/api/core'
import { useChatStore } from '../../../stores/chatStore'
import { useAgentStore } from '../../../stores/agentStore'

export async function executePlan(args: string, projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()
  const agentStore = useAgentStore.getState()

  if (!args.trim()) {
    chatStore.addSystemMessage(
      '❌ Usage: `/plan <description of what you want to build>`\n\n' +
      'Example: `/plan user authentication with email, Google login, and role-based access`'
    )
    return
  }

  // Mostrar a mensagem do user
  chatStore.addUserMessage(`/plan ${args}`)

  // FASE 1+2: Architect gera o plano
  const messageId = chatStore.startAssistantMessage()
  agentStore.setStatus('thinking')

  const architectPrompt = buildArchitectPrompt(args, projectPath)

  const agentService = AgentService.getInstance()
  const contextBuilder = ContextBuilder.getInstance()
  const systemPrompt = await contextBuilder.buildSystemPrompt(projectPath, '')

  // O agente corre como Architect — gera PLAN.md
  await agentService.runAgentLoop(
    architectPrompt,
    [],
    agentService.getToolDefinitions(),
    {
      onTextDelta: (delta) => {
        agentStore.setStatus('generating')
        chatStore.appendTextDeltaBuffered(delta)
      },
      onReasoningDelta: (delta) => {
        chatStore.appendReasoningDelta(delta)
      },
      onToolCallPending: (name) => {
        agentStore.setStatus('applying')
        chatStore.addPendingToolCall(name)
      },
      onToolCallStart: (name, input) => {
        chatStore.updateToolCallWithArgs(name, input)
      },
      onToolCallResult: (name, result, isError) => {
        chatStore.updateToolCallWithResult(name, result, isError)
        agentStore.setStatus('thinking')
      },
      onTurnComplete: (turn) => {
        chatStore.incrementTurnCount()
      },
      onDone: (finalText) => {
        chatStore.finalizeAssistantMessage()
        agentStore.setStatus('idle')

        // FASE 3: Mostrar PlanApprovalCard
        chatStore.addPlanApprovalCard(projectPath)
      },
      onError: (error) => {
        agentStore.setStatus('error')
        agentStore.setError(error.message)
        chatStore.finalizeAssistantMessage()
      },
      onUsageUpdate: (prompt, completion) => {
        chatStore.addTokenUsage(prompt, completion)
      },
      onQueuedMessageConsumed: (id) => {
        chatStore.markQueueConsumed(id)
      }
    }
  )
}

function buildArchitectPrompt(userIdea: string, projectPath: string): string {
  return `You are acting as a SOFTWARE ARCHITECT. The user wants to build something and needs a complete plan before any code is written.

## User's Idea
"${userIdea}"

## Your Task

Analyze the existing project (read TMS.md, package.json, project structure) and create a comprehensive development plan.

Write a file called PLAN.md at ${projectPath}/PLAN.md with this EXACT structure:

\`\`\`markdown
# Development Plan

> Generated by ToqueMedia Studio Architect
> Date: {current date}
> Status: PENDING APPROVAL

## 1. Overview

### What We're Building
{2-3 sentences describing the feature/system in concrete terms}

### Goals
{3-5 bullet points of what this achieves for the user}

### Out of Scope
{what this plan explicitly does NOT include}

---

## 2. Architecture

### System Design
{high-level architecture — how components connect}
{use ASCII diagrams where helpful}

### Data Model
{entities, relationships, key fields}
{use a simple table or ASCII diagram}

### API / Routes
{endpoints or routes needed, method, purpose}

### State Management
{what state is needed, where it lives, how it flows}

---

## 3. Functional Specs

{for each feature/screen, describe:}

### 3.1 {Feature Name}
- **What it does:** {user-facing behavior}
- **Inputs:** {what the user provides}
- **Outputs:** {what the user sees/gets}
- **Business Rules:** {validation, constraints, edge cases}
- **Error States:** {what can go wrong and how to handle it}

### 3.2 {Feature Name}
...

---

## 4. Visual Specs

{for each screen/view, describe the layout:}

### 4.1 {Screen Name}
- **Layout:** {describe the layout structure}
- **Components:** {list UI components needed}
- **Interactions:** {click, hover, drag, transitions}
- **Responsive:** {how it adapts to different sizes}

{use ASCII wireframes where helpful:}
\\\`\\\`\\\`
┌─────────────────────────────────┐
│ Header / Nav                    │
├──────────┬──────────────────────┤
│ Sidebar  │ Main Content         │
│          │ ┌──────────────────┐ │
│ - Item 1 │ │ Data Table       │ │
│ - Item 2 │ │                  │ │
│ - Item 3 │ └──────────────────┘ │
│          │ [Add New] [Export]   │
└──────────┴──────────────────────┘
\\\`\\\`\\\`

### 4.2 {Screen Name}
...

---

## 5. Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| {what} | {chosen option} | {why} |
| ... | ... | ... |

---

## 6. File Structure

{new files and directories to create}
\\\`\\\`\\\`
src/
  components/
    {new components}
  services/
    {new services}
  types/
    {new types}
\\\`\\\`\\\`

---

## 7. Complexity Estimate

| Phase | Tasks | Complexity |
|-------|-------|------------|
| {phase} | {count} | {low/medium/high} |

**Total estimated tasks:** {number}
**Estimated complexity:** {low/medium/high}

\`\`\`

## IMPORTANT INSTRUCTIONS:

1. READ the project first — understand the existing stack, conventions, and structure
2. If TMS.md exists, read it and follow its conventions
3. Be SPECIFIC — no vague descriptions. Every spec should be implementable.
4. Use ASCII wireframes for visual specs — they're more useful than words
5. Consider the EXISTING code — don't propose changes that conflict with what's already built
6. Data models should include field names and types
7. API routes should include method, path, request/response shape
8. The plan must be COMPLETE — a developer should be able to implement from this alone
9. Write the plan to PLAN.md using write_file
10. After writing PLAN.md, give a brief summary in the chat (3-5 sentences of what you planned)`
}
```

### 3.3 PlanApprovalCard — UI de aprovação

**Criar:** `src/components/chat/PlanApprovalCard.tsx`

Um componente inline no chat que aparece após o agente gerar o plano.

```typescript
interface PlanApprovalCardProps {
  projectPath: string
  onApprove: () => void
  onRequestChanges: () => void
  onReject: () => void
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected'
}

function PlanApprovalCard({
  projectPath,
  onApprove,
  onRequestChanges,
  onReject,
  status
}: PlanApprovalCardProps) {
  return (
    <Box
      bg="bg.elevated"
      border="1px solid"
      borderColor="border.default"
      borderRadius="lg"
      p={4}
      my={2}
    >
      <Flex align="center" gap={2} mb={3}>
        <Text fontSize="lg">📋</Text>
        <Text fontWeight="bold" color="text.primary">
          Plan Ready for Review
        </Text>
      </Flex>

      <Text fontSize="sm" color="text.muted" mb={4}>
        The architect has generated a complete development plan.
        Review PLAN.md and decide how to proceed.
      </Text>

      {/* Botão para abrir PLAN.md no editor */}
      <Button
        size="sm"
        variant="outline"
        mb={4}
        onClick={() => {
          // Abrir PLAN.md no editor panel
          const editorStore = useEditorStore.getState()
          editorStore.openFile(`${projectPath}/PLAN.md`)
          useLayoutStore.getState().setViewMode('editor')
        }}
      >
        📄 View Full Plan
      </Button>

      {status === 'pending' && (
        <Flex gap={2}>
          <Button
            size="sm"
            colorScheme="green"
            onClick={onApprove}
          >
            ✅ Approve — Generate Tasks
          </Button>
          <Button
            size="sm"
            colorScheme="yellow"
            onClick={onRequestChanges}
          >
            ✏️ Request Changes
          </Button>
          <Button
            size="sm"
            colorScheme="red"
            variant="outline"
            onClick={onReject}
          >
            ❌ Reject
          </Button>
        </Flex>
      )}

      {status === 'approved' && (
        <Badge colorScheme="green" fontSize="sm">✅ Approved</Badge>
      )}

      {status === 'changes_requested' && (
        <Badge colorScheme="yellow" fontSize="sm">✏️ Changes requested — reply in chat</Badge>
      )}

      {status === 'rejected' && (
        <Badge colorScheme="red" fontSize="sm">❌ Rejected</Badge>
      )}
    </Box>
  )
}
```

### 3.4 Handlers de aprovação

**No componente pai (ChatPanel ou onde PlanApprovalCard é renderizado):**

```typescript
async function handlePlanApprove(projectPath: string) {
  // Actualizar status do card
  chatStore.updatePlanStatus('approved')

  // FASE 4: Gerar todo list
  chatStore.addSystemMessage('✅ Plan approved. Generating development task list...')

  const messageId = chatStore.startAssistantMessage()
  agentStore.setStatus('thinking')

  const todoPrompt = buildTodoPrompt(projectPath)

  await agentService.runAgentLoop(
    todoPrompt,
    [],
    agentService.getToolDefinitions(),
    {
      // ... callbacks standard ...
      onDone: (finalText) => {
        chatStore.finalizeAssistantMessage()
        agentStore.setStatus('idle')

        // Mostrar TodoListCard
        chatStore.addTodoListCard(projectPath)
      }
    }
  )
}

function handlePlanRequestChanges() {
  chatStore.updatePlanStatus('changes_requested')
  chatStore.addSystemMessage(
    '✏️ What changes would you like? Describe in the chat and the architect will revise the plan.'
  )
  // O próximo prompt do user será processado normalmente
  // O agente vê o PLAN.md existente e as instruções de mudança
}

function handlePlanReject() {
  chatStore.updatePlanStatus('rejected')
  chatStore.addSystemMessage('❌ Plan rejected. You can start a new plan with `/plan`.')
}
```

### 3.5 Todo Prompt — Gerar lista de tarefas

```typescript
function buildTodoPrompt(projectPath: string): string {
  return `Read the approved PLAN.md at ${projectPath}/PLAN.md and generate a detailed development task list.

Write a file called TODO.md at ${projectPath}/TODO.md with this structure:

\`\`\`markdown
# Development Tasks

> Generated from PLAN.md by ToqueMedia Studio
> Date: {current date}
> Status: 0/{total} tasks completed

---

## Phase 1 — {Phase Name} (Foundation)

- [ ] **Task 1.1:** {specific, actionable task}
  - Files: {files to create/modify}
  - Depends on: none
  
- [ ] **Task 1.2:** {specific, actionable task}
  - Files: {files to create/modify}
  - Depends on: Task 1.1

## Phase 2 — {Phase Name} (Core Features)

- [ ] **Task 2.1:** {specific, actionable task}
  - Files: {files to create/modify}
  - Depends on: Phase 1

- [ ] **Task 2.2:** {specific, actionable task}
  - Files: {files to create/modify}
  - Depends on: Task 2.1

## Phase 3 — {Phase Name} (Polish & Integration)

- [ ] **Task 3.1:** ...

---

## Summary

| Phase | Tasks | Depends On |
|-------|-------|------------|
| Phase 1 — {name} | {count} | — |
| Phase 2 — {name} | {count} | Phase 1 |
| Phase 3 — {name} | {count} | Phase 2 |

**Total: {count} tasks**
\`\`\`

## INSTRUCTIONS:

1. Read PLAN.md first
2. Break each feature/spec into small, atomic tasks (1-2 hours each max)
3. Order tasks by dependency — never reference a task that hasn't been done yet
4. Group into phases (foundation → core → polish)
5. Each task must specify which files it creates or modifies
6. Each task must be concrete enough that a developer can start immediately
7. Include setup tasks (install deps, create directories, config files)
8. Include testing tasks where appropriate
9. Write to TODO.md using write_file
10. Present a summary in the chat`
}
```

### 3.6 TodoListCard — UI da lista de tarefas

**Criar:** `src/components/chat/TodoListCard.tsx`

```typescript
interface TodoListCardProps {
  projectPath: string
  onStartExecution: () => void
}

function TodoListCard({ projectPath, onStartExecution }: TodoListCardProps) {
  const [tasks, setTasks] = useState<TodoTask[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Ler e parsear TODO.md
    loadTasks(projectPath).then(t => {
      setTasks(t)
      setLoading(false)
    })
  }, [projectPath])

  return (
    <Box
      bg="bg.elevated"
      border="1px solid"
      borderColor="border.default"
      borderRadius="lg"
      p={4}
      my={2}
      maxH="400px"
      overflowY="auto"
    >
      <Flex align="center" gap={2} mb={3}>
        <Text fontSize="lg">📝</Text>
        <Text fontWeight="bold" color="text.primary">
          Development Plan ({tasks.length} tasks)
        </Text>
      </Flex>

      {tasks.map((task, index) => (
        <Box key={index}>
          {task.isPhaseHeader && (
            <Text
              fontWeight="bold"
              fontSize="sm"
              color="text.accent"
              mt={3}
              mb={1}
            >
              {task.text}
            </Text>
          )}
          {!task.isPhaseHeader && (
            <Flex gap={2} py={1} pl={4}>
              <Text fontSize="sm" color="text.muted">□</Text>
              <Text fontSize="sm" color="text.primary">{task.text}</Text>
            </Flex>
          )}
        </Box>
      ))}

      <Flex gap={2} mt={4}>
        <Button
          size="sm"
          colorScheme="blue"
          onClick={onStartExecution}
        >
          ▶️ Start Execution
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const editorStore = useEditorStore.getState()
            editorStore.openFile(`${projectPath}/TODO.md`)
            useLayoutStore.getState().setViewMode('editor')
          }}
        >
          📄 View TODO.md
        </Button>
      </Flex>
    </Box>
  )
}

interface TodoTask {
  text: string
  isPhaseHeader: boolean
  completed: boolean
}

async function loadTasks(projectPath: string): Promise<TodoTask[]> {
  try {
    const content = await invoke<string>('read_file', {
      path: `${projectPath}/TODO.md`
    })

    const tasks: TodoTask[] = []

    for (const line of content.split('\n')) {
      const trimmed = line.trim()

      // Phase header: "## Phase 1 — ..."
      if (trimmed.startsWith('## Phase')) {
        tasks.push({ text: trimmed.replace('## ', ''), isPhaseHeader: true, completed: false })
        continue
      }

      // Task: "- [ ] **Task 1.1:** ..."
      const taskMatch = trimmed.match(/^- \[([ x])\] \*\*(.+?)\*\*:?\s*(.*)/)
      if (taskMatch) {
        const completed = taskMatch[1] === 'x'
        const taskText = `${taskMatch[2]} ${taskMatch[3]}`.trim()
        tasks.push({ text: taskText, isPhaseHeader: false, completed })
      }
    }

    return tasks
  } catch {
    return []
  }
}
```

### 3.7 Start Execution — iniciar o trabalho

Quando o user clica "▶️ Start Execution", o agente começa a executar as tarefas sequencialmente:

```typescript
async function handleStartExecution(projectPath: string) {
  const chatStore = useChatStore.getState()

  chatStore.addSystemMessage('▶️ Starting plan execution...')

  const executionPrompt = `Read the TODO.md at ${projectPath}/TODO.md and start executing the tasks IN ORDER.

For each task:
1. Announce which task you're starting
2. Implement it completely
3. Mark it as done in TODO.md by changing "- [ ]" to "- [x]"
4. Move to the next task

If you encounter a problem:
- Try to solve it
- If you can't, explain the issue and move to the next task
- Add the blocked task to the "Pending Tasks" section of TMS.md

Update TMS.md Memory section as you complete milestones.

Start with the first uncompleted task.`

  // Executar via agentic loop normal
  chatStore.addUserMessage('Start executing the development plan')
  const messageId = chatStore.startAssistantMessage()
  useAgentStore.getState().setStatus('thinking')

  await agentService.runAgentLoop(
    executionPrompt,
    [],
    agentService.getToolDefinitions(),
    {
      // ... callbacks standard ...
    }
  )
}
```

### 3.8 PLAN.md e TODO.md carregados no contexto

**Ficheiro:** `src/services/agent/contextBuilder.ts`

Adicionar: se PLAN.md ou TODO.md existem, carregar no system prompt para o agente ter contexto do plano.

```typescript
async buildSystemPrompt(projectPath: string, projectType: string): Promise<string> {
  // ... código existente ...

  // Carregar TMS.md
  let tmsBlock = ''
  try {
    const tmsContent = await invoke<string>('read_file', { path: `${projectPath}/TMS.md` })
    tmsBlock = `\n\n## Project Memory (TMS.md)\n\n${tmsContent}`
  } catch {}

  // Carregar PLAN.md se existir
  let planBlock = ''
  try {
    const planContent = await invoke<string>('read_file', { path: `${projectPath}/PLAN.md` })
    planBlock = `\n\n## Active Development Plan (PLAN.md)\n\n${planContent}`
  } catch {}

  // Carregar TODO.md se existir
  let todoBlock = ''
  try {
    const todoContent = await invoke<string>('read_file', { path: `${projectPath}/TODO.md` })
    todoBlock = `\n\n## Task List (TODO.md)\n\n${todoContent}`
  } catch {}

  // Skills
  const skills = await skillService.loadSkills(projectPath, projectType)
  const skillsBlock = skillService.buildSkillsPromptBlock(skills)

  return `${basePrompt}${tmsBlock}${planBlock}${todoBlock}${skillsBlock}`
}
```

### 3.9 Actualizar chatStore — novos tipos de cards

**Ficheiro:** `src/stores/chatStore.ts`

```typescript
// Novos tipos de mensagens inline
interface ChatMessage {
  // ... campos existentes ...

  // Cards inline
  cardType?: 'plan_approval' | 'todo_list'
  cardStatus?: 'pending' | 'approved' | 'changes_requested' | 'rejected'
  cardProjectPath?: string
}

// Novas actions
interface ChatActions {
  // ... actions existentes ...

  addPlanApprovalCard: (projectPath: string) => void
  updatePlanStatus: (status: ChatMessage['cardStatus']) => void
  addTodoListCard: (projectPath: string) => void
}
```

---

## 4. Comando /payments — Stub

### 4.1 Implementação stub

**Criar:** `src/services/agent/commands/paymentsCommand.ts`

```typescript
import { useChatStore } from '../../../stores/chatStore'

export async function executePaymentsStub(args: string, projectPath: string): Promise<void> {
  const chatStore = useChatStore.getState()

  chatStore.addSystemMessage(
    `🔜 /payments command is coming soon.\n\n` +
    `This will load MoMenu Payment Skills:\n` +
    `• mom-factura-payments — MCX, E-kwanza, Referência Bancária\n` +
    `• mom-factura-webhooks — Webhook confirmations\n` +
    `• mom-factura-testing — QA environment & testing\n\n` +
    `In the meantime, you can install manually:\n` +
    `\`npx skills add ithustle/momenu-skills\``
  )
}
```

---

## 4. Exemplo de TMS.md gerado

Após `/init` num projecto React + TypeScript + Vite:

```markdown
# TMS — Project Memory

> Auto-generated by ToqueMedia Studio. Last updated: 2026-03-16
> This file is read by the AI agent at the start of each session.

---

## Project Analysis

### Overview
- **Name:** my-dashboard
- **Framework:** React 19
- **Language:** TypeScript 5.7
- **Package Manager:** npm
- **Monorepo:** no

### Commands
- **Install:** `npm install`
- **Dev:** `npm run dev` (Vite on port 5173)
- **Build:** `npm run build`
- **Test:** `npm test` (Vitest)
- **Lint:** `npm run lint` (ESLint)

### Structure
- `src/components/` — React components (PascalCase)
- `src/hooks/` — Custom hooks (useAuth, useFetch)
- `src/services/` — API calls and business logic
- `src/stores/` — Zustand stores
- `src/types/` — TypeScript type definitions
- `src/utils/` — Helper functions

### Conventions Detected
- Functional components with React.memo
- Zustand for state management (create pattern)
- Path aliases: @/ → src/
- CSS Modules for styling
- Barrel exports (index.ts) in component directories

### Dependencies (Key)
- react 19.0.0 — UI framework
- zustand 5.0.0 — State management
- react-router-dom 7.0.0 — Routing
- axios 1.7.0 — HTTP client
- zod 3.23.0 — Schema validation
- vitest 2.1.0 — Testing framework

---

## Memory

### Milestones


### Decisions


### Pending Tasks


---

## Custom Instructions

Add your project-specific instructions below. These will guide the AI agent.

```

Após algum trabalho do agente, a secção Memory fica:

```markdown
## Memory

### Milestones
- [2026-03-16] Login component created with email/password validation
- [2026-03-16] Auth service integrated with Firebase Auth
- [2026-03-17] Dashboard layout with sidebar navigation

### Decisions
- [2026-03-16] Chose Zod over Yup for form validation — better TS inference
- [2026-03-16] Auth tokens stored in httpOnly cookies, not localStorage
- [2026-03-17] Sidebar state persisted in Zustand with localStorage middleware

### Pending Tasks
- [ ] Add password reset flow
- [ ] Implement role-based access control
- [ ] Add unit tests for auth service
- [ ] Setup CI/CD pipeline
```

---

## 5. Keyboard shortcuts para autocomplete

**No PromptBar:**

- `/` no início do input → abre menu de comandos
- `↑` / `↓` → navegar comandos
- `Enter` ou `Tab` → seleccionar comando
- `Esc` → fechar menu
- Continuar a escrever → filtra comandos (ex: `/in` filtra para `/init`)

---

## Critérios de Done

### Slash Command System:
- [ ] `slashCommandRegistry.ts` criado — register, filter, execute
- [ ] PromptBar mostra autocomplete dropdown ao escrever `/`
- [ ] Navegação com ↑/↓, selecção com Enter/Tab, Esc fecha
- [ ] Comandos disabled mostram "coming soon" badge
- [ ] Placeholder do input menciona "type / for commands"

### /init:
- [ ] `initCommand.ts` criado
- [ ] Agente analisa projecto via tools (list_directory, read_file)
- [ ] TMS.md gerado na raiz do projecto com estrutura correcta
- [ ] Secções: Project Analysis + Memory + Custom Instructions
- [ ] Se TMS.md já existe, agente actualiza Analysis mas preserva Memory e Custom Instructions
- [ ] TMS.md carregado automaticamente no system prompt via contextBuilder
- [ ] System prompt inclui instruções para o agente actualizar a secção Memory
- [ ] Agente actualiza Memory após completar milestones/decisões

### /plan:
- [ ] `planCommand.ts` criado
- [ ] Agente actua como Architect — analisa projecto + user input
- [ ] PLAN.md gerado com 7 secções (Overview, Architecture, Functional Specs, Visual Specs, Technical Decisions, File Structure, Complexity)
- [ ] Specs visuais incluem ASCII wireframes
- [ ] `PlanApprovalCard.tsx` criado — aparece inline no chat
- [ ] Botão "View Full Plan" abre PLAN.md no editor
- [ ] Botão "Approve" dispara geração de TODO.md
- [ ] Botão "Request Changes" permite feedback no chat
- [ ] Botão "Reject" cancela o plano
- [ ] TODO.md gerado com tarefas atómicas, ordenadas por dependência, agrupadas em fases
- [ ] `TodoListCard.tsx` criado — mostra lista de tarefas inline no chat
- [ ] Botão "Start Execution" dispara execução sequencial das tarefas
- [ ] Agente marca tarefas como `[x]` no TODO.md à medida que completa
- [ ] PLAN.md e TODO.md carregados no system prompt via contextBuilder
- [ ] Agente actualiza TMS.md Memory durante execução do plano

### /payments:
- [ ] `paymentsCommand.ts` criado como stub
- [ ] Comando aparece no autocomplete com badge "coming soon"
- [ ] Ao executar, mostra mensagem informativa com instruções manuais
- [ ] `enabled: false` — não executa lógica real

### Integração:
- [ ] TMS.md tem prioridade máxima no system prompt (após base, antes de skills)
- [ ] PLAN.md e TODO.md carregados no system prompt quando existem
- [ ] `npm run build` sem erros

---

## O que NÃO fazer

- Não implementar /payments (apenas stub)
- Não forçar /init automático ao abrir projecto (user decide quando executar)
- Não guardar TMS.md, PLAN.md, TODO.md em `.tms/` — ficam na raiz (visíveis, commitáveis, editáveis)
- Não permitir ao agente apagar ou reescrever secções Memory e Custom Instructions no /init
- Não implementar sub-comandos (/init --force, /plan --dry-run)
- Não implementar execução paralela de tarefas do TODO.md (sequencial apenas)
- Não implementar estimativa de tempo por tarefa (apenas complexidade)
- Não modificar o Worker
