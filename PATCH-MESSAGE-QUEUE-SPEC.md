# Patch: Fila de Mensagens do User (Message Queue)

> **Destino:** Claude Code  
> **Projecto:** `exodus-ide/` (IDE)  
> **Pré-requisito:** Patch Streaming aplicado  
> **Objectivo:** O user pode enviar mensagens a qualquer momento, mesmo enquanto o agente está a trabalhar. As mensagens são injectadas no próximo turn ou ficam em fila se o agente está a streamar.

---

## Comportamento

```
Cenário 1 — Agente entre turns (a executar tool):
  User envia: "Ah, também adiciona validação no email"
  → Mensagem injectada imediatamente no próximo request ao LLM
  → O agente vê a mensagem no contexto e adapta-se

Cenário 2 — Agente a streamar resposta (tokens a chegar):
  User envia: "Esqueci de dizer, usa Zod para validação"
  → Mensagem entra na fila (visível no chat)
  → Quando o turn actual acabar, mensagem injectada no próximo turn

Cenário 3 — Agente idle:
  User envia: "Cria um componente de login"
  → Comportamento normal, inicia novo loop
```

---

## Arquitectura

```
                    ┌─────────────┐
User envia msg ───▶ │ messageQueue │
                    └──────┬──────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
     Agente idle    Agente entre      Agente a
                    turns             streamar
           │               │               │
     Inicia loop    Injeta no         Fica na fila
     normal         próximo turn      até turn acabar
```

---

## 1. Criar messageQueue no chatStore

**Ficheiro:** `src/stores/chatStore.ts`

### Novo estado:

```typescript
interface ChatState {
  // ... estado existente ...

  // Message queue
  pendingUserMessages: QueuedMessage[]
}

interface QueuedMessage {
  id: string
  content: string
  timestamp: number
}
```

### Novas actions:

```typescript
interface ChatActions {
  // ... actions existentes ...

  // Queue
  enqueueUserMessage: (content: string) => void
  dequeueAllMessages: () => QueuedMessage[]
  peekQueue: () => QueuedMessage[]
  clearQueue: () => void
  hasQueuedMessages: () => boolean
}
```

### Implementação:

```typescript
enqueueUserMessage: (content) => {
  set((state) => ({
    pendingUserMessages: [
      ...state.pendingUserMessages,
      {
        id: crypto.randomUUID(),
        content,
        timestamp: Date.now()
      }
    ]
  }))
}

dequeueAllMessages: () => {
  const messages = get().pendingUserMessages
  set({ pendingUserMessages: [] })
  return messages
}

hasQueuedMessages: () => {
  return get().pendingUserMessages.length > 0
}
```

---

## 2. Actualizar agentService — consumir fila entre turns

**Ficheiro:** `src/services/agent/agentService.ts`

**Onde:** No agentic loop, entre a execução das tools e o próximo request ao LLM.

**Estado actual do loop:**
```
1. Request ao LLM
2. Stream resposta
3. Se tool_calls → executar tools
4. Adicionar tool results ao messages
5. Voltar a 1
```

**Novo loop:**
```
1. Request ao LLM
2. Stream resposta
3. Se tool_calls → executar tools
4. Adicionar tool results ao messages
5. NOVO: Verificar fila de mensagens do user
6. Se há mensagens → injectar antes do próximo request
7. Voltar a 1
```

### Implementação no loop:

```typescript
async runAgentLoop(
  userMessage: string,
  conversationHistory: any[],
  tools: any[],
  callbacks: AgentCallbacks
): Promise<void> {
  this.abortController = new AbortController()

  const messages = [
    ...conversationHistory,
    { role: 'user', content: userMessage }
  ]

  let turnCount = 0
  const MAX_TURNS = 50

  while (turnCount < MAX_TURNS) {
    turnCount++

    // === Request ao LLM + Stream ===
    const response = await this.callStreamingAPI(messages, tools)
    const turnResult = await this.processStreamedTurn(response, callbacks)

    // Adicionar assistant message ao histórico
    messages.push({
      role: 'assistant',
      content: turnResult.textContent || null,
      tool_calls: turnResult.toolCalls.length > 0
        ? turnResult.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) }
          }))
        : undefined
    })

    // Usage
    if (turnResult.usage) {
      callbacks.onUsageUpdate(turnResult.usage.promptTokens, turnResult.usage.completionTokens)
    }

    // Se não há tool calls, verificar fila antes de terminar
    if (turnResult.finishReason !== 'tool_calls' || turnResult.toolCalls.length === 0) {
      
      // === NOVO: Verificar fila ===
      const queuedMessages = this.consumeQueuedMessages()
      
      if (queuedMessages.length > 0) {
        // Há mensagens na fila — injectar e continuar o loop
        for (const msg of queuedMessages) {
          callbacks.onQueuedMessageConsumed(msg.id)
          messages.push({ role: 'user', content: msg.content })
        }
        // NÃO terminar o loop — continuar com as novas mensagens
        callbacks.onTurnComplete(turnCount)
        continue
      }

      // Fila vazia — loop termina
      callbacks.onDone(turnResult.textContent || '')
      return
    }

    // === Executar tools ===
    const toolResults = []
    for (const toolCall of turnResult.toolCalls) {
      callbacks.onToolCallStart(toolCall.name, toolCall.args)

      try {
        const result = await this.toolExecutor.execute(toolCall.name, toolCall.args)
        toolResults.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: result
        })
        callbacks.onToolCallResult(toolCall.name, result, false)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        toolResults.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: `Error: ${errorMsg}`
        })
        callbacks.onToolCallResult(toolCall.name, errorMsg, true)
      }
    }

    // Adicionar tool results
    for (const result of toolResults) {
      messages.push(result)
    }

    // === NOVO: Verificar fila entre turns (após tools) ===
    const queuedMessages = this.consumeQueuedMessages()
    
    if (queuedMessages.length > 0) {
      // Injectar mensagens do user após os tool results
      for (const msg of queuedMessages) {
        callbacks.onQueuedMessageConsumed(msg.id)
        messages.push({ role: 'user', content: msg.content })
      }
    }

    callbacks.onTurnComplete(turnCount)
  }

  callbacks.onError(new Error(`Agent exceeded maximum turns (${MAX_TURNS})`))
}

// Consumir fila do chatStore
private consumeQueuedMessages(): QueuedMessage[] {
  const chatStore = useChatStore.getState()
  if (!chatStore.hasQueuedMessages()) return []
  return chatStore.dequeueAllMessages()
}
```

---

## 3. Actualizar PromptBar — sempre activo

**Ficheiro:** `src/components/PromptBar.tsx`

**Estado actual:** PromptBar fica disabled quando `isStreaming === true`.

**Novo:** PromptBar fica **sempre activo**. O user pode sempre escrever e enviar.

### Mudança na lógica de Send:

```typescript
async function handleSend(prompt: string) {
  const chatStore = useChatStore.getState()
  const agentStore = useAgentStore.getState()

  if (agentStore.status === 'idle') {
    // Agente parado — iniciar novo loop normal
    chatStore.addUserMessage(prompt)
    const messageId = chatStore.startAssistantMessage()
    agentStore.setStatus('thinking')

    await agentService.runAgentLoop(...)
    
  } else {
    // Agente a trabalhar — enfileirar mensagem
    chatStore.addUserMessage(prompt)         // Mostrar no chat imediatamente
    chatStore.enqueueUserMessage(prompt)     // Colocar na fila para o agente
  }
}
```

### Mudanças visuais no PromptBar:

```typescript
// ANTES:
<Textarea disabled={isStreaming} ... />

// DEPOIS:
<Textarea disabled={false} ... />

// Placeholder muda conforme estado:
const placeholder = agentStatus === 'idle'
  ? 'Describe what you want to build...'
  : 'Add instructions for the agent... (will be sent to next turn)'
```

### Indicador visual de que é mensagem queued:

Quando o user envia durante trabalho do agente, a mensagem aparece no chat com um indicador visual:

```typescript
// No MessageBubble:
{message.isQueued && (
  <Badge size="xs" colorScheme="yellow">
    Queued — will be sent to agent
  </Badge>
)}
```

Quando o agente consome a mensagem da fila, o badge desaparece (ou muda para "Sent to agent ✓").

---

## 4. Actualizar ChatMessage type

**Ficheiro:** `src/types/chat.ts`

```typescript
interface ChatMessage {
  // ... campos existentes ...

  // Queue status
  isQueued?: boolean        // true se está na fila, ainda não consumida pelo agente
  queueConsumed?: boolean   // true quando o agente consumiu da fila
}
```

---

## 5. Novo callback — onQueuedMessageConsumed

**Ficheiro:** `src/services/agent/agentService.ts`

**Adicionar ao `AgentCallbacks`:**

```typescript
interface AgentCallbacks {
  // ... callbacks existentes ...

  // Quando uma mensagem queued é consumida pelo loop
  onQueuedMessageConsumed: (messageId: string) => void
}
```

**Wiring no PromptBar/handleSend:**

```typescript
onQueuedMessageConsumed: (messageId) => {
  // Marcar mensagem como consumida no chat
  chatStore.markQueueConsumed(messageId)
}
```

**Nova action no chatStore:**

```typescript
markQueueConsumed: (queuedMessageId: string) => {
  set((state) => {
    // Encontrar a mensagem no chat e actualizar
    const session = state.sessions.get(state.activeSessionId!)
    if (!session) return state

    const messages = session.messages.map(msg => {
      if (msg.id === queuedMessageId) {
        return { ...msg, isQueued: false, queueConsumed: true }
      }
      return msg
    })

    return {
      sessions: new Map(state.sessions).set(state.activeSessionId!, {
        ...session,
        messages
      })
    }
  })
}
```

---

## 6. UI — Fila visível no chat

O flow visual fica:

```
┌─────────────────────────────────────────┐
│ 👤 User: Cria um componente de login    │
│                                         │
│ 🤖 Assistant:                           │
│    🤔 Thinking... (collapsed)           │
│    Vou criar o componente de login...   │
│    📄 read_file: package.json           │
│    ✅ Read 1.2KB                        │
│                                         │
│ 👤 User: Também adiciona validação      │  ← enviada durante trabalho
│    ⏳ Queued — will be sent to agent    │  ← badge
│                                         │
│ 👤 User: Usa Zod para a validação       │  ← outra durante trabalho
│    ⏳ Queued — will be sent to agent    │  ← badge
│                                         │
│ 🤖 Assistant: (continua trabalhando)    │
│    📝 write_file: src/Login.tsx         │
│    ┌─── Diff ───────────────────────┐   │
│    │ ...                            │   │
│    │ [Yes] [Yes, for all] [No]      │   │
│    └────────────────────────────────┘   │
│                                         │
│    ✅ Sent to agent                     │  ← badge updated (validação)
│    ✅ Sent to agent                     │  ← badge updated (Zod)
│                                         │
│    Entendido, vou adicionar validação   │  ← agente processou as msgs
│    com Zod...                           │
│    📝 edit_file: src/Login.tsx          │
│    ┌─── Diff ───────────────────────┐   │
│    │ + import { z } from 'zod'      │   │
│    │ ...                            │   │
│    └────────────────────────────────┘   │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ Add instructions for the agent...   │ │  ← sempre activo
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

## 7. Edge cases

### 7.1 Fila + permissões

Se o agente está à espera de permissão (PermissionDialog visível) e o user envia mensagem:
- A mensagem entra na fila normalmente
- O PermissionDialog mantém-se visível (prioridade sobre a fila)
- O agente consome a fila quando retomar após a permissão

### 7.2 Fila + cancel

Se o user cancela o loop (botão Stop):
- O loop termina
- Mensagens na fila permanecem como mensagens normais no chat (não são descartadas)
- O user pode iniciar novo loop — as mensagens queued anteriores ficam no histórico como contexto

### 7.3 Múltiplas mensagens na fila

Se o user envia 3 mensagens durante um turn, todas são injectadas juntas no próximo turn:

```
messages: [
  ...histórico,
  { role: 'tool', tool_call_id: '...', content: '...' },   // tool result
  { role: 'user', content: 'Também adiciona validação' },    // queued 1
  { role: 'user', content: 'Usa Zod' },                      // queued 2
  { role: 'user', content: 'E adiciona testes' }              // queued 3
]
```

O LLM vê todas de uma vez e processa.

### 7.4 Fila + sessão nova

Se o user troca de sessão ou cria nova:
- A fila é limpa
- Mensagens que estavam queued ficam no chat da sessão anterior como mensagens normais (sem badge)

---

## Critérios de Done

- [ ] `pendingUserMessages` no chatStore
- [ ] `enqueueUserMessage`, `dequeueAllMessages`, `hasQueuedMessages` actions
- [ ] Agentic loop verifica fila entre turns e após fim de loop
- [ ] Mensagens queued injectadas no array de messages antes do próximo request
- [ ] PromptBar sempre activo (nunca disabled)
- [ ] Placeholder muda conforme estado do agente
- [ ] Mensagens queued visíveis no chat com badge "Queued"
- [ ] Badge actualiza para "Sent to agent ✓" quando consumida
- [ ] `onQueuedMessageConsumed` callback funciona
- [ ] Cancel não descarta mensagens queued
- [ ] Troca de sessão limpa a fila
- [ ] Múltiplas mensagens queued são injectadas juntas
- [ ] `npm run build` sem erros

---

## O que NÃO fazer

- Não implementar edição de mensagens queued (futuro)
- Não implementar reordenação de fila
- Não implementar prioridade de mensagens
- Não bloquear o PromptBar em nenhuma circunstância (excepto se não autenticado)
- Não enviar mensagens queued como requests separados — sempre injectar no loop existente
- Não modificar o Worker
- Não modificar o streamParser
