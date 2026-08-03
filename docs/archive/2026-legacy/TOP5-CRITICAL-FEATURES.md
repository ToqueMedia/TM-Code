> **HISTÓRICO (arquivado 2026-08-03) — NÃO reflecte o presente.** Ex.: o #3 afirma que o `execute_command` não tem timeout — hoje tem (120s default/600s máx). Fonte actual: `TMS.md` + `ARCHITECTURE.md` na raiz.

# Top 5 Funcionalidades Críticas em Falta

**TM Code — AI Agent-First IDE**
*Data: 2026-03-17*

---

## ~~1. Undo/Rollback de alterações do agente~~ ✓

Implementado: Checkpoint system com snapshots automáticos antes de cada tool call que modifica ficheiros. Painel visual no chat com botão "Undo" e revert por checkpoint.

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

## ~~4. Histórico de versões por sessão (Session Snapshots)~~ ✓

Implementado: Session baseline tracking com lazy snapshots. O sistema captura o conteúdo original dos ficheiros no primeiro acesso e permite comparar "antes da sessão" vs "agora" via `getSessionDiff()`.

---

## 5. Custom instructions por projecto (`.tmcode` ou similar)

Não existe forma do developer configurar o agente per-projecto:
- "Usa Tailwind, não CSS puro"
- "Segue o padrão de componentes em `/src/components`"
- "Os testes estão em `__tests__/` com Jest"
- "Usa português nas mensagens de UI"

O Claude Code tem `CLAUDE.md`, o Cursor tem `.cursorrules`, o Codex tem `AGENTS.md`. O TM Code não tem equivalente.

**Porquê crítico**: Sem isto, o developer repete as mesmas instruções em cada sessão. A qualidade do output do agente degrada porque não conhece as convenções do projecto.
