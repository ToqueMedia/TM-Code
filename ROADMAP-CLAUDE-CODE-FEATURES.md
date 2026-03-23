# Features Absorvidas do Claude Code — Roadmap

> Análise de features do Claude Code Desktop que o TM Code pode absorver para superar o Cursor.
> Data: 2026-03-21

## Contexto

O Cursor é um VS Code fork com AI colada. O Claude Code é um agente sem corpo.
O TM Code pode ser o meio-termo ideal: **Agente autónomo com corpo visual** — planeia antes de agir, lembra o que aprendeu, trabalha em paralelo, mostra tudo em tempo real, e o utilizador mantém o controlo total.

---

## P0 — Em Implementação

> Estas 3 features estão a ser implementadas activamente. Ver código fonte.

- **Plan Mode** — Agente analisa e propõe plano visual antes de executar. Utilizador revê/aprova steps.
- **Memory System Cross-Session** — Memória persistente por projecto que sobrevive entre sessões.
- **Sub-Agents Paralelos** — Múltiplos agentes concorrentes para tarefas complexas.

---

## P0 — Project Instructions (`.tmcode.md`)

**Esforço:** Baixo | **Impacto:** Alto

- Suportar `.tms/instructions.md` (ou `.tmcode.md`) no root do projecto
- Sempre injectado no system prompt, acima de tudo
- UI para editar directamente na Settings ou via comando
- Hierarquia: global (`~/.toquemedia-studio/instructions.md`) + projecto
- Referência: equivalente ao `CLAUDE.md` do Claude Code e `.cursorrules` do Cursor, mas mais rico

---

## P1 — Git Agentic Tools

**Esforço:** Médio | **Impacto:** Alto

- Tools dedicados: `git_commit`, `git_branch`, `git_push`, `create_pr`
- Agente sugere commit messages baseadas nas alterações que fez
- "Commit what I just did" como acção natural no chat
- Safety protocols: nunca force push, nunca amend sem pedir, branch protection
- PR creation com summary auto-gerado das mudanças do agente

---

## P1 — Background Tasks com Notificação

**Esforço:** Médio | **Impacto:** Médio

- Tool `execute_command_background` que retorna imediatamente com task ID
- Agente continua a editar ficheiros enquanto build/tests correm
- Notificação async quando comando termina (success/fail + output)
- UI mostra tasks em background com status no StatusBar

---

## P2 — Permission Allowlists

**Esforço:** Baixo | **Impacto:** Médio

- Allowlist por comando: `["npm *", "yarn *", "git commit"]` → auto-approved
- Denylist explícita: `["rm -rf", "git push --force"]` → sempre bloqueado
- Per-project e global config
- UI para gerir regras na Settings
- "Trust this tool for this session" como opção no PermissionDialog

---

## P2 — Hooks System (Event-Driven Automation)

**Esforço:** Médio | **Impacto:** Médio

- Hooks configuráveis: `onBeforeSave`, `onAfterCommit`, `onAgentComplete`, `onFileCreate`
- Exemplo: "depois de cada save, corre eslint" ou "depois de commit, corre tests"
- Config em `.tms/hooks.json` ou na Settings
- Output dos hooks visível no Output panel
