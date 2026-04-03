# Agent Registry — Substituição Completa da Arquitectura de Sub-Agentes

**Status:** Planeado
**Prioridade:** Médio prazo
**Tipo:** Substituição completa (não adaptação)

## Contexto

O Claude Code tem um sistema de sub-agentes declarativo com registry central. O TM Code tem 3 tools ad-hoc (`research`, `verify`, `spawn_background_agent`) com ~80 linhas de boilerplate cada, configuração inline, sem extensibilidade.

## Arquitectura Alvo (baseada no Claude Code)

### Uma tool, múltiplos tipos

```
Tool: agent (uma única tool)
  → subagent_type: "research" | "verify" | "explore" | "plan" | custom
  → dispatch centralizado para AgentDefinition do registry
```

### AgentDefinition (interface declarativa)

```typescript
interface AgentDefinition {
  agentType: string                    // identificador único
  whenToUse: string                    // descrição para o modelo (para dispatch)
  source: 'built-in' | 'user' | 'project'
  tools?: string[]                     // allow-list (se definido, só estas tools)
  disallowedTools?: string[]           // deny-list (remove estas do pool completo)
  getSystemPrompt: () => string        // prompt dinâmico
  model?: string                       // model override (e.g., usar modelo mais barato para verify)
  maxTurns?: number                    // limite de turns
  readOnly?: boolean                   // bloqueia escrita mecanicamente (tools + bash security)
  color?: string                       // cor no UI
  memory?: 'user' | 'project'         // memória persistente entre sessões
}
```

### Built-in agents (código)

```
src/services/agent/agents/
  researchAgent.ts      → tools: read + write + search
  verificationAgent.ts  → readOnly: true, disallowedTools: [write_file, edit_file, create_file]
  exploreAgent.ts       → tools: read + search only, maxTurns: 20
  backgroundAgent.ts    → readOnly: true, background: true
```

### Custom agents (ficheiros .md com frontmatter)

```markdown
---
name: test-runner
description: Runs tests and reports results. Use after code changes.
tools: [read_file, execute_command, get_diagnostics, read_dev_server_logs]
maxTurns: 15
---

You are a test runner agent inside TM Code...
```

Localização: `~/.toquemedia-studio/agents/` (user) ou `.toquemedia-studio/agents/` (projecto)

### Registry central

```typescript
class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map()
  
  register(agent: AgentDefinition): void
  get(type: string): AgentDefinition | undefined
  getAll(): AgentDefinition[]
  loadFromDirectory(dir: string): Promise<void>  // carrega .md files
}
```

### Dispatch na tool `agent`

```typescript
this.tools.set('agent', {
  execute: async (input) => {
    const type = input.subagent_type as string
    const definition = agentRegistry.get(type)
    if (!definition) return `Unknown agent type: ${type}`
    
    const tools = this.assembleToolPool(definition)
    const subAgent = AgentService.createLightweight({ tools, ... })
    subAgent.setSystemPrompt(definition.getSystemPrompt())
    // ... run loop
  }
})
```

### Bash security para agentes read-only

Quando `readOnly: true`, o execute_command deve bloquear:
- Redirects: `>`, `>>`, `|` para ficheiros
- Inline edits: `sed -i`, `perl -i`
- Move/copy/delete: `mv`, `cp`, `rm`, `mkdir`, `touch`
- Write tools via shell: `echo > file`, `cat > file`, `tee`

## Ficheiros a criar/modificar

- **NOVO:** `src/services/agent/agentRegistry.ts` — registry central
- **NOVO:** `src/services/agent/agents/` — directório com definições built-in
- **NOVO:** `src/services/agent/bashSecurity.ts` — validação de comandos read-only
- **MODIFICAR:** `src/services/agent/toolExecutor.ts` — substituir 3 tools por 1 tool `agent`
- **MODIFICAR:** `src/services/agent/contextBuilder.ts` — gerar descrições de agentes dinamicamente

## Princípios

1. **Substituição completa** — não adaptar o código existente, reescrever
2. **Declarativo** — agentes definidos por dados, não por código imperativo
3. **Extensível** — utilizadores podem criar agentes via .md files
4. **Seguro** — read-only enforcement mecânico (não apenas prompt)
5. **Compatível** — a tool `agent` mantém interface similar ao CC para que o prompt funcione
