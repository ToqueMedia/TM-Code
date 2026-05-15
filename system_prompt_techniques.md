# System Prompt Engineering — Manual de Técnicas
## Princípios Extraídos do System Prompt do Claude Code

*Observados em `constants/prompts.ts`, `memdir/`, `services/compact/prompt.ts` e `tools/AgentTool/built-in/`*

---

## 1. Composição Modular — Section Builders Puros

Cada secção do prompt é uma função pura que retorna `string`. O prompt completo é resultado de compor essas funções, não de manter um literal gigante.

```ts
function getSimpleIntroSection(): string { ... }
function getActionsSection(): string { ... }
function getUsingYourToolsSection(enabledTools: Set<string>): string { ... }

return [
  getSimpleIntroSection(),
  getSimpleSystemSection(),
  getActionsSection(),
  getUsingYourToolsSection(enabledTools),
  // ...
].filter(s => s !== null).join('\n')
```

Vantagens: cada secção é testável isoladamente, condicionalmente incluída (`filter(null)`), memoizada por chave, e edits não causam merge conflicts massivos.

---

## 2. Boundary Estática/Dinâmica para Cache

O prompt tem um marcador explícito separando conteúdo cacheável globalmente de conteúdo session-specific:

```ts
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

return [
  // --- Static (cacheable cross-org) ---
  getSimpleIntroSection(),
  getActionsSection(),
  // ...
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  // --- Dynamic (per-session) ---
  ...resolvedDynamicSections,
]
```

Princípio: cada bit dinâmico colocado **antes** do boundary multiplica o número de variantes do hash de cache (2^N). Empurre a sessionalidade para depois do boundary; o que pode ser estático **deve** ser estático.

---

## 3. Cached vs Uncached Sections — com Justificação Obrigatória

Quando uma secção tem de invalidar cache, a API obriga a explicar porquê:

```ts
DANGEROUS_uncachedSystemPromptSection(
  'mcp_instructions',
  () => getMcpInstructionsSection(mcpClients),
  'MCP servers connect/disconnect between turns'  // ← justificação obrigatória
)
```

O nome `DANGEROUS_` é deliberado — força o autor a parar e considerar se a invalidação é realmente necessária. Cache-busting é decisão arquitetural, não default.

---

## 4. Phrasing Eval-Validado (com IDs de hipótese)

Cada decisão de phrasing é tratada como hipótese científica, com resultado registado em comentário:

```ts
// Header wording matters: "Before recommending" (action cue at the decision
// point) tested better than "Trusting what you recall" (abstract). The
// appendSystemPrompt variant with this header went 3/3; the abstract header
// went 0/3 in-place. Same body text — only the header differed.
'## Before recommending from memory'
```

```ts
// Eval-validated (memory-prompt-iteration.eval.ts, 2026-03-17):
//   H1 (verify function/file claims): 0/2 → 3/3 via appendSystemPrompt.
//   H5 (read-side noise rejection): 0/2 → 3/3 via appendSystemPrompt
```

Princípio: phrasing não é gosto pessoal — é hipótese mensurável. Documente o experimento que validou cada formulação não-óbvia.

---

## 5. Posição como Variável Empírica

A mesma frase em posições diferentes produz resultados diferentes:

```ts
// When buried as a bullet under "When to access", dropped to 0/3 — position
// matters. The H1 cue is about what to DO with a memory, not when to look,
// so it needs its own section-level trigger context.
```

Princípio: se uma regra crítica não está sendo seguida, antes de re-escrevê-la, **mova-a**. Section header > top-level bullet > nested bullet. Trigger de decisão = top-level.

---

## 6. Counterweight Bullets — Gated por Modelo

Cada fine-tune introduz drift em alguma direção. O prompt corrige com bullets adicionais, gated ao modelo afetado, removidos quando validados externamente:

```ts
// @[MODEL LAUNCH]: capy v8 thoroughness counterweight (PR #24302)
// — un-gate once validated on external via A/B
...(process.env.USER_TYPE === 'ant' ? [
  `Before reporting a task complete, verify it actually works...`
] : [])

// @[MODEL LAUNCH]: False-claims mitigation for Capybara v8
// (29-30% FC rate vs v4's 16.7%)
```

Princípio: cada model launch é uma regressão. Mantenha um inventário de counterweights, gated por user-type/build, com data de revisão.

---

## 7. Numeric Anchors A/B-testados

Frases qualitativas ("be concise") são vagas. Limites numéricos são mensuráveis:

```ts
// Numeric length anchors — research shows ~1.2% output token reduction vs
// qualitative "be concise". Ant-only to measure quality impact first.
'Length limits: keep text between tool calls to ≤25 words.
 Keep final responses to ≤100 words unless the task requires more detail.'
```

Princípio: substitua "concise" por `≤N words`. Substitua "soon" por `within 3 turns`. Validar por A/B antes de generalizar.

---

## 8. WHAT > HOW (mas com **estrutura obrigatória** quando o output é livre)

Constraints são outcome-shaped, não prescritivos:

```
Don't add error handling, fallbacks, or validation for scenarios that
can't happen. Trust internal code and framework guarantees. Only validate
at system boundaries (user input, external APIs).
```

**Mas** quando o output é uma memória/decisão livre, força-se estrutura:

```
<body_structure>
Lead with the rule itself, then a **Why:** line and a **How to apply:** line.
Knowing *why* lets you judge edge cases instead of blindly following.
</body_structure>
```

Princípio: WHAT para constraints comportamentais; estrutura mecânica para outputs persistentes.

---

## 9. Two-Step com Commitment Mecânico

Para tarefas onde a ordem importa, o prompt enumera passos com ações concretas:

```
Saving a memory is a two-step process:

**Step 1** — write the memory to its own file using this frontmatter format: ...
**Step 2** — add a pointer to that file in `MEMORY.md`. ...
```

Princípio: passos numerados + verbos mecânicos (write, add, append) eliminam ambiguidade. "Save the memory" → o modelo decide; "Step 1: write file. Step 2: add pointer" → o modelo executa.

---

## 10. XML Tags Dentro de Markdown — Hierarquia Mensageiável

Markdown para legibilidade, XML para estrutura semântica que o modelo possa parsear:

```xml
<types>
<type>
    <name>feedback</name>
    <description>...</description>
    <when_to_save>...</when_to_save>
    <how_to_use>...</how_to_use>
    <body_structure>...</body_structure>
    <examples>...</examples>
</type>
</types>
```

Princípio: XML quando há schema repetido (n×types, n×examples). Markdown quando o output é prosa única. Coexistem sem conflito.

---

## 11. Negative Space Explícito ("What NOT to do")

Listas anti-padrão, com a override-gambit pre-empted:

```
## What NOT to save in memory
- Code patterns, conventions, architecture, file paths — these can be derived...
- Git history, recent changes — `git log` / `git blame` are authoritative.
- Debugging solutions — the fix is in the code...

These exclusions apply even when the user explicitly asks you to save.
If they ask you to save a PR list, ask what was *surprising* — that is
the part worth keeping.
```

A última frase é o detalhe crítico: o usuário pode tentar dar override; o prompt antecipa o gambit e re-direciona. Eval-validado: "0/2 → 3/3".

---

## 12. Bookend (U-Curve) para Constraints Irreversíveis

Quando uma falha custa o turno inteiro, a regra aparece **no início** e **no fim**, com a consequência nomeada:

```
[início]
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Tool calls will be REJECTED and will waste your only turn —
  you will fail the task.

[corpo do prompt: instruções de sumarização]

[fim]
REMINDER: Do NOT call any tools. Respond with plain text only.
Tool calls will be rejected and you will fail the task.
```

Comentário no código: "0.01% on 4.5 vs 2.79% on 4.6 — putting this FIRST and making it explicit about rejection consequences prevents the wasted turn."

Princípio: bookend só onde uma única falha é catastrófica. Não bookend tudo (vira ruído).

---

## 13. Drafting Scratchpad + Post-Processing

Pede-se ao modelo que pense num bloco que depois é **stripped** antes do output ir para o destino:

```
Before providing your final summary, wrap your analysis in <analysis> tags...

<example>
<analysis>
[Your thought process, ensuring all points are covered]
</analysis>
<summary>
[Final summary]
</summary>
</example>
```

```ts
// Strip analysis section — it's a drafting scratchpad that improves summary
// quality but has no informational value once the summary is written.
formattedSummary = formattedSummary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
```

Princípio: o modelo escreve melhor quando pode rascunhar. O destino não precisa ver o rascunho. XML tags + regex de pós-processamento = thinking sem custo de contexto downstream.

---

## 14. Direct Quotes para Preservar Intent Across Boundaries

Em sumarizações que cruzam compaction, o prompt exige **citações verbatim** do user:

```
9. Optional Next Step: ...
   If there is a next step, include direct quotes from the most recent
   conversation showing exactly what task you were working on. This should
   be verbatim to ensure there's no drift in task interpretation.
```

Princípio: quanto mais boundaries (compaction, sub-agentes, hand-offs) o intent atravessa, maior o drift. Verbatim quotes são um anti-drift que sobrevive à paráfrase.

---

## 15. Read-Only via Defense-in-Depth (Prompt + Harness)

Para sub-agentes específicos, a restrição vai no prompt **e** no runtime:

```ts
// PROMPT
=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation)
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

// HARNESS
disallowedTools: [
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
],
```

Princípio: nunca confie em prompt sozinho para invariantes de segurança. Double-enforce no harness. O prompt orienta intenção; o harness garante.

---

## 16. Mode-Aware Sections (Modo Calibra Comportamento)

O mesmo modelo opera em modos diferentes; o prompt detecta o modo e ajusta:

```
The user context may include a `terminalFocus` field:
- **Unfocused**: The user is away. Lean heavily into autonomous action —
  make decisions, explore, commit, push. Only pause for irreversible actions.
- **Focused**: The user is watching. Be more collaborative — surface
  choices, ask before committing to large changes.
```

Outras switches observáveis: `autonomous` vs `interactive`, `proactive` vs `reactive`, `REPL mode`, `worktree session`. Cada um muda blocos específicos do prompt.

Princípio: o mesmo agente em modo diferente é, comportamentalmente, agente diferente. Sinalize o modo no prompt e calibre granularmente.

---

## 17. Caller-Parameterized Verbosity

O caller — não o prompt — define o esforço esperado:

```
Adapt your search approach based on the thoroughness level specified
by the caller: "quick" for basic searches, "medium" for moderate
exploration, or "very thorough" for comprehensive analysis.
```

Princípio: parametrize o esforço (quick / medium / thorough) e deixe o caller escolher. Evita prompts duplicados (`getQuickPrompt`, `getThoroughPrompt`) e empurra a decisão para quem tem o contexto.

---

## 18. Closed Taxonomy + Graceful Degradation

Para campos com semantica fixa, taxonomia fechada validada em código:

```ts
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  return MEMORY_TYPES.find(t => t === raw)
  // Invalid or missing: returns undefined — legacy files keep working,
  // unknown types degrade gracefully.
}
```

Princípio: enum fechado no prompt **e** no parser. O modelo não pode inventar tipo `urgent` ou `tagging`. Tipos novos requerem mudança de código (deliberate).

---

## 19. Index/Entries Split com Caps Auto-Reportados

Estrutura de dois níveis: índice curto + arquivos detalhados; caps automáticos com warning nomeado:

```ts
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000

if (wasLineTruncated || wasByteTruncated) {
  truncated += `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}.
Only part of it was loaded. Keep index entries to one line under
~200 chars; move detail into topic files.`
}
```

Princípio: contexto não é elástico. Caps explícitos + warning nomeando qual cap disparou + sugestão de remediação. O modelo aprende o limite empiricamente.

---

## 20. Tool Names Interpolados (Decoupling Build-Time)

Prompts não hardcodam nomes de ferramentas:

```ts
`To read files use ${FILE_READ_TOOL_NAME} instead of cat, head, tail`
`To search files use ${GLOB_TOOL_NAME} instead of find or ls`
`Reserve using the ${BASH_TOOL_NAME} exclusively for...`
```

Princípio: rename do tool em `tools/Read/constants.ts` propaga automaticamente. Build-time consistency sem prompt drift. Bonus: builds com tools embedded swap a string sem reescrever o prompt:

```ts
const grepGuidance = embedded
  ? `Use \`grep\` via ${BASH_TOOL_NAME} for searching`
  : `Use ${GREP_TOOL_NAME} for searching`
```

---

## 21. Anti-Recap Continuation

Após compaction, o prompt instrui contra o impulso natural de re-summarizar:

```
Continue the conversation from where it left off without asking the user
any further questions. Resume directly — do not acknowledge the summary,
do not recap what was happening, do not preface with "I'll continue" or
similar. Pick up the last task as if the break never happened.
```

Princípio: nomeie explicitamente os comportamentos default que custam tokens e atrito. "Não diga 'Vou continuar'" é mais eficaz que "seja conciso".

---

## 22. Telemetria por Secção

Cada loaded prompt-section dispara um event. Permite atribuir regressões a phrasing changes:

```ts
logEvent('tengu_memdir_loaded', {
  content_length: t.byteCount,
  line_count: t.lineCount,
  was_truncated: t.wasLineTruncated,
  was_byte_truncated: t.wasByteTruncated,
  memory_type: 'auto',
})
```

Princípio: prompt engineering sem telemetria é folclore. Cada secção condicional, cada cap, cada feature flag — instrumentado.

---

## Resumo Visual — Checklist Construtivo

| # | Camada | Técnica | Quando aplicar |
|---|---|---|---|
| 1 | **Estrutura** | Section builders puros | Sempre — qualquer prompt > 100 linhas |
| 2 | **Estrutura** | Static/dynamic boundary | Quando há cache de prompt |
| 3 | **Estrutura** | Cached vs uncached explicit | Quando há sections per-turn |
| 4 | **Phrasing** | Eval-validated com hash | Para regras críticas que pareciam triviais |
| 5 | **Phrasing** | Posição como variável | Quando uma regra é ignorada apesar de presente |
| 6 | **Phrasing** | Counterweight gated por modelo | Após cada model launch com regressão |
| 7 | **Phrasing** | Numeric anchors | Para limites quantificáveis (length, turns, retries) |
| 8 | **Conteúdo** | WHAT > HOW + estrutura forçada | Constraints livres + outputs persistentes |
| 9 | **Conteúdo** | Two-step com verbos mecânicos | Sequências onde a ordem importa |
| 10 | **Conteúdo** | XML dentro de markdown | Schema repetido (n×types) |
| 11 | **Conteúdo** | Negative space + override-gambit | Quando o usuário pode tentar bypass |
| 12 | **Robustez** | Bookend U-Curve | Quando 1 falha custa o turno inteiro |
| 13 | **Robustez** | Drafting scratchpad | Outputs longos onde quality > brevity |
| 14 | **Robustez** | Direct quotes verbatim | Hand-offs entre compaction/sub-agentes |
| 15 | **Robustez** | Read-only: prompt + harness | Invariantes de segurança |
| 16 | **Modo** | Mode-aware sections | Mesmo agente em contextos distintos |
| 17 | **Modo** | Caller-parameterized verbosity | Quando o caller tem o contexto |
| 18 | **Persistência** | Closed taxonomy + graceful | Campos com semântica fixa |
| 19 | **Persistência** | Index/entries split + caps | Memória ou state crescente |
| 20 | **Persistência** | Tool names interpolados | Sempre — zero hardcoded names |
| 21 | **Persistência** | Anti-recap continuation | Após qualquer summarization |
| 22 | **Operação** | Telemetria por secção | Sempre — atribuição de regressões |

---

### Origem das Técnicas

- `constants/prompts.ts` — section builders, boundary, feature gates, counterweights, numeric anchors
- `memdir/memdir.ts` + `memdir/memoryTypes.ts` — taxonomia fechada, body_structure, eval IDs, drift caveat, override-gambit
- `services/compact/prompt.ts` — bookend, drafting scratchpad, direct quotes, anti-recap
- `tools/AgentTool/built-in/exploreAgent.ts` — read-only defense-in-depth, caller-parameterized verbosity
- `constants/systemPromptSections.ts` — `DANGEROUS_uncached` API com reason obrigatório
