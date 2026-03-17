# Top 5 Funcionalidades Críticas em Falta

**TM Code — AI Agent-First IDE**
*Data: 2026-03-17*

---

## 1. Undo/Rollback de alterações do agente

O agente pode modificar 10 ficheiros numa sessão. Se algo correu mal, **não há forma de voltar atrás** além de `Cmd+Z` ficheiro a ficheiro no editor (se estiver aberto). Não existe:
- "Desfazer última acção do agente" (volta todos os ficheiros ao estado anterior)
- Checkpoint antes de cada tool call do agente
- Histórico visual de alterações por sessão

**Porquê crítico**: Num IDE onde o agente escreve a maior parte do código, o developer precisa de confiança para dizer "vai em frente" — e essa confiança vem de saber que pode reverter. Sem isto, o developer hesita em aprovar diffs.

---

## 2. Visualização de erros do projecto (Problems Panel)

O `ProblemsContent.tsx` existe mas tem **dados mock hardcoded**. O developer não vê:
- Erros de TypeScript/ESLint aggregados de todo o projecto
- Warnings do build
- Erros do dev server num painel organizado

O agente tem `get_diagnostics` para ficheiros individuais, mas o developer não tem visibilidade do estado geral do projecto.

**Porquê crítico**: Depois do agente criar/editar código, o developer precisa de saber rapidamente se o projecto compila. "0 errors, 3 warnings" é informação essencial que não existe.

---

## 3. `execute_command` sem timeout — pode bloquear indefinidamente

O Rust `Command::new().output()` não tem limite de tempo. Se o agente correr `npm test` num projecto com testes que hangam, ou `npm install` com network lento, **o agent loop fica preso para sempre**. O user tem de cancelar manualmente sem saber porquê.

**Porquê crítico**: Num IDE agent-first, o agente corre comandos autonomamente. Um hang silencioso é a pior experiência possível — o developer fica a olhar para "Applying changes..." indefinidamente.

---

## 4. Histórico de versões por sessão (Session Snapshots)

O agente altera ficheiros ao longo de uma sessão. Não existe:
- "Antes da sessão" vs "depois da sessão" diff
- Snapshot do projecto no início de cada sessão
- Capacidade de comparar o estado do projecto entre sessões

**Porquê crítico**: O developer quer saber "o que mudou desde que comecei a trabalhar com o agente hoje?" — especialmente quando houve 20+ turns com múltiplos ficheiros alterados.

---

## 5. Custom instructions por projecto (`.tmcode` ou similar)

Não existe forma do developer configurar o agente per-projecto:
- "Usa Tailwind, não CSS puro"
- "Segue o padrão de componentes em `/src/components`"
- "Os testes estão em `__tests__/` com Jest"
- "Usa português nas mensagens de UI"

O Claude Code tem `CLAUDE.md`, o Cursor tem `.cursorrules`, o Codex tem `AGENTS.md`. O TM Code não tem equivalente.

**Porquê crítico**: Sem isto, o developer repete as mesmas instruções em cada sessão. A qualidade do output do agente degrada porque não conhece as convenções do projecto.
