# Plano: Rules & Memories

## 1. Rules (Prioridade 1)

### Storage
- Pasta: `.tms/rules/` no projecto
- Global: `~/.toquemedia-studio/rules/`
- Formato por ficheiro:
```markdown
---
name: "Nome da regra"
type: "always" | "manual" | "model_decision" | "file_specific"
glob: "*.tsx,*.ts"          # só para type=file_specific
description: "Quando aplicar" # só para type=model_decision
---
Conteúdo da regra em linguagem natural...
```
- Limite total: 100K caracteres across all active rules

### contextBuilder integration
- Novo método `loadRules(projectPath)` que:
  1. Lê `.tms/rules/` + `~/.toquemedia-studio/rules/`
  2. Filtra por tipo: `always` vai sempre; `file_specific` filtra pelo glob vs ficheiros no contexto
  3. `model_decision` inclui descrição para o modelo decidir
  4. `manual` só inclui quando invocado via `@rule-name`
- Injecto como `<rules>` section no prompt, entre environment e constraints
- Budget: 12K chars para rules (separado do skills budget)
- Prioridade: project rules > global rules

### UI (Settings > Rules)
- Nova tab "Rules" no SettingsView
- Lista de regras com: nome, tipo (badge), glob pattern
- Botão "Add Rule" → form com: nome, tipo (dropdown), glob (condicional), textarea para conteúdo
- Edit inline / Delete por regra
- Indicator de chars usados vs limite

### Agent tool
- `@rule-name` no prompt para invocar regras manuais (reusa lógica do `@skill`)

---

## 2. Memories Estruturadas (Prioridade 2)

### Storage
- Pasta projecto: `.tms/memories/`
- Global: `~/.toquemedia-studio/memories/`
- Um ficheiro JSON por entrada:
```json
{
  "id": "uuid",
  "content": "O user prefere Tailwind a CSS modules",
  "category": "preference" | "decision" | "milestone" | "issue",
  "createdAt": "2026-03-27T10:00:00Z",
  "source": "agent" | "user"
}
```

### contextBuilder integration
- Novo método `loadMemories(projectPath)` que:
  1. Lê `.tms/memories/` + `~/.toquemedia-studio/memories/`
  2. Ordena por data (mais recentes primeiro)
  3. Trunca ao budget (6K chars)
  4. Project memories > global memories
- Substitui a leitura actual de TMS.md secção Memory
- Injecto como `<memories>` section no prompt

### Agent tools
- Nova tool `save_memory`: agent guarda memória estruturada (substitui edit de TMS.md)
- Nova tool `delete_memory`: agent apaga memória por id
- Remover instrução actual de "update TMS.md Memory section" do contextBuilder

### UI (Settings > Memories)
- Nova tab "Memories" no SettingsView
- Lista com: conteúdo (truncado), categoria (badge), data, source (agent/user)
- Toggle: "Project" / "Global"
- Delete individual por memória
- Campo para adicionar memória manualmente

### Migração
- Na primeira abertura, ler TMS.md secção Memory, converter entradas para ficheiros individuais em `.tms/memories/`

---

## 3. Memória Global (Prioridade 3)

- Storage: `~/.toquemedia-studio/memories/` (já definido acima)
- Quando o agent detecta preferência cross-project (idioma, estilo, frameworks), guarda como memória global
- contextBuilder carrega global + project, project tem prioridade em conflitos
- UI: toggle "Global" na tab Memories mostra memórias globais

---

## 4. Memória Automática (Prioridade 4)

- Agent analisa conversas e extrai automaticamente:
  - Decisões arquitecturais ("usamos Zustand em vez de Redux")
  - Preferências de estilo ("o user pediu para não usar semicolons")
  - Issues resolvidos ("bug X era causado por Y")
- Implementação: instrução no system prompt para o agent chamar `save_memory` quando detecta informação reutilizável
- Sem ML/heurísticas complexas — é prompt engineering no contextBuilder
- Rate limit: máximo 3 memórias automáticas por sessão (evita spam)

---

## Ordem de implementação
1. Rules: storage → loader no contextBuilder → UI
2. Memories: storage → tools do agent → loader no contextBuilder → UI
3. Global memories: extensão do storage + contextBuilder
4. Auto-memory: instrução no prompt + rate limiting
