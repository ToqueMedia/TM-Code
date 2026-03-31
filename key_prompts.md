# System Prompt Engineering
## 15 Princípios para Maximizar LLMs
*Toque Media — Dev Studio & TMS*

---

## 1. Estrutura e Organização

Use delimitadores explícitos (XML tags ou markdown headers) para separar secções do prompt. Isto elimina ambiguidade quando o prompt mistura instruções, contexto, exemplos e inputs variáveis.

```
<role>...</role>
<instructions>...</instructions>
<examples>...</examples>
<output_format>...</output_format>
```

Posicionamento estratégico importa — os LLMs sofrem do efeito "Lost in the Middle": conteúdo no início (primacy) e no fim (recency) do prompt é melhor retido. Instruções críticas devem estar no início E repetidas no fim como reminder.

*Isto é o padrão U-Curve: COMPLETION RULE no início + REMINDER no fim.*

---

## 2. Clareza e Directividade

- Diz o que fazer, não o que não fazer. Em vez de "não uses markdown", diz "responde em prosa fluida".
- Sê explícito sobre o formato de saída. Define a estrutura exacta esperada.
- Dá contexto/motivação. Explicar porquê uma regra existe permite ao modelo generalizar para casos não previstos.

### Exemplo

```
# Menos eficaz
NEVER use ellipses

# Mais eficaz
Your response will be read aloud by a TTS engine,
so never use ellipses since TTS cannot pronounce them.
```

---

## 3. Few-Shot Examples (3–5 exemplos)

A técnica de maior ROI consistente. Os exemplos devem ser:

- **Relevantes** — espelham o caso de uso real
- **Diversos** — cobrem edge cases para que o modelo não aprenda padrões acidentais
- **Estruturados** — envolvidos em `<example>` tags para distinguir de instruções

### Formato

```xml
<examples>
  <example>
    <input>...</input>
    <output>...</output>
  </example>
</examples>
```

---

## 4. Role Assignment (Persona)

Definir um role foca o comportamento, tom e domínio de conhecimento do modelo. Mesmo uma frase faz diferença:

```
You are a senior frontend engineer specializing in React + Tailwind.
```

Evita roles vagos. "You are a helpful assistant" não acrescenta nada.

---

## 5. Chain-of-Thought e Raciocínio

Para tarefas complexas, encoraja raciocínio passo-a-passo:

- **Instrução geral > passos prescritivos.** "Think thoroughly" produz melhor raciocínio do que um plano rígido step-by-step.
- **Self-check.** Adiciona "Before finishing, verify your answer against [criteria]" — apanha erros em código e matemática.
- **Thinking examples.** Usa `<thinking>` tags nos few-shot examples para mostrar o padrão de raciocínio.

---

## 6. Constraints como Contrato

Define restrições como um contrato vinculativo, não como sugestões:

```
## BLUEPRINT CONTRACT
- Component count: render exactly the count specified
- Data fields: render every field listed — no omissions
- staticDecisions: implement each one exactly as described
```

Isto é mais eficaz do que "try to follow the blueprint". Os LLMs respondem melhor a linguagem assertiva e inequívoca.

---

## 7. Context Engineering (Token Budget)

O princípio central: encontra o menor conjunto de tokens de alto sinal que maximize a probabilidade do output desejado.

- **Dados longos no topo, query/instruções no fim** — melhora performance até 30%
- **Just-in-time retrieval** em vez de pre-carregar tudo
- **Compaction** — comprimir histórico preservando decisões arquitecturais, descartando output redundante
- **Context como recurso finito** — context rot (degradação de recall) afecta todos os modelos

---

## 8. Altitude Certa (Goldilocks Zone)

O prompt deve estar calibrado na altitude certa — entre dois extremos:

| Demasiado Rígido | Goldilocks | Demasiado Vago |
|---|---|---|
| if user says X, do Y; if Z, do W | Princípios claros com exemplos | "Be helpful and smart" |
| Brittle, quebra em edge cases | Generalizável | O modelo inventa comportamento |

---

## 9. Output Format Explícito

Define a estrutura de saída com delimitadores exactos:

```
SCREEN_START:{"id":"...","name":"..."}
<html>...</html>
SCREEN_END
```

Ou usa JSON Schema / Structured Outputs quando disponível. O modelo segue formatos demonstrados com muito mais fidelidade do que formatos apenas descritos.

---

## 10. Gestão de Incerteza e Hallucinations

- **Permissão explícita para dizer "não sei"** — reduz hallucinations
- **Investiga antes de responder** — "Never speculate about code you have not opened"
- **Grounding em citações** — para tarefas com documentos longos, pede ao modelo para citar trechos relevantes antes de responder

---

## 11. Completion Rules e Guardrails

Regras que garantem completude do output:

```
COMPLETION RULE: Emit EVERY screen in screens[], in order.
Do not skip. Do not stop early.

REMINDER: Emit ALL screens. Do not stop until the last SCREEN_END.
```

O padrão de bookend (regra no início + reminder no fim) explora o U-Curve e é o mais robusto para outputs longos.

---

## 12. Avoid Over-Engineering no Prompt

Paradoxalmente, prompts demasiado longos e complexos degradam performance:

- **Remove "anti-laziness" prompting em modelos recentes** (Claude 4.x, GPT-5) — eles já são proactivos
- **Evita instruções conflitantes** — o modelo tenta satisfazer todas e falha em todas
- **Calibra agressividade** — onde antes dizias "CRITICAL: You MUST use this tool", agora basta "Use this tool when..."
- **Não re-ensines o modelo** — não gastes tokens a instruir competências que o modelo já tem nativamente. Dizer "think step by step" a um frontier model que já faz chain-of-thought por defeito, ou "write clean, well-structured code" a um modelo treinado para coding, é ruído que compete com as instruções que realmente importam. Antes de adicionar uma instrução, pergunta: "o modelo já faz isto sem eu pedir?" Se sim, remove.

> **Nota:** Todos os modelos activos no pipeline são frontier-class (Step 3.5 Flash, MiniMax M2.5, GLM-5, Claude). A remoção de anti-laziness prompting aplica-se a todos. Modelos de propósito limitado como mimo-v2-flash (prototype coder, single-turn) ainda beneficiam de completion rules assertivas por operarem fora do loop agentic.

---

## 13. Temperature & Sampling Strategy

O prompt e os parâmetros de sampling são um par — não elementos independentes. O mesmo system prompt produz outputs radicalmente diferentes com parâmetros diferentes.

### Processo

1. Consultar a documentação oficial do modelo para os parâmetros recomendados (temperature, top_p, top_k, stop conditions)
2. Usar esses como baseline
3. Ajustar com base em testes no caso de uso específico
4. Documentar a configuração final e a justificação

Cada agent no pipeline pode ter parâmetros diferentes conforme o modelo e a tarefa. Não assumir valores universais — o que funciona num modelo pode degradar outro.

---

## 14. Output Length Management

Completion rules garantem que o modelo não para cedo. Mas falta o controlo inverso — verbosidade excessiva. "Be concise" é vago e viola o princípio da Goldilocks Zone (ponto 8).

### Técnicas Concretas

- **Token budgets por secção:** "section X must not exceed Y lines"
- **Structured output** com campos de tamanho delimitado no schema
- **Instruções específicas por tipo:** "code comments: one line per block, no inline narration"
- **U-Curve para comprimento:** testar se a instrução funciona melhor no início, no fim, ou em ambos

A calibração depende do modelo — alguns respondem bem a limites numéricos, outros precisam de exemplos que demonstrem o comprimento desejado (few-shot implícito de brevidade).

---

## 15. Error Recovery / Self-Correction Protocol

O ponto 5 menciona self-check como verificação antes de finalizar. Falta o protocolo de recuperação quando a verificação detecta um problema. Sem instrução explícita, o modelo decide sozinho — às vezes corrige, às vezes ignora, às vezes regenera tudo desnecessariamente.

### Protocolo Explícito

```
If verification fails:
1. Identify the specific violation
2. Fix only the violated section
3. Re-verify only that section
4. Do not regenerate the entire output
```

Particularmente relevante para outputs longos (código, arquitecturas, multi-screen) onde regenerar tudo por causa de um erro localizado desperdiça tokens e pode introduzir novas regressões.

A granularidade do protocolo deve ser adaptada ao modelo e à tarefa. Para modelos com context window limitado, a instrução "fix only the violated section" evita que o modelo perca contexto ao tentar refazer tudo.

---

## 16. WHAT vs HOW — Autonomous Models (Kimi K2.5)

Modelos treinados para autonomia agentic (Kimi K2.5, MoE com PARL training) seguem instruções de **resultado** (WHAT) mas ignoram instruções de **implementação** (HOW). A documentação oficial do Moonshot confirma: *"There is no need to specify the tools or their usage instructions in the System Prompt — this may actually interfere with autonomous decision-making."*

### Padrão observado

| Tipo | Seguido? | Exemplo |
|------|----------|---------|
| WHAT (constraint/outcome) | Sim | "All payment calls MUST originate from paymentService.ts" |
| WHAT (deadline) | Sim | "First edit MUST happen within 3 turns" |
| HOW (tool usage) | Não | "Call web_fetch({ url: '...' })" |
| HOW (implementation) | Não | "import { payWithMCX } from '../lib/paymentService'" |

### Como aplicar

- **Escreve constraints** ("payment calls originate ONLY from paymentService.ts"), não instruções ("import payWithMCX from paymentService")
- **Mostra exemplos contrastivos** (CORRECT vs WRONG) em vez de passos prescritivos
- **Define deadlines** ("first edit within 3 turns") em vez de workflows ("call plan_tasks first")
- **Remove tool names** do system prompt — o modelo já tem as tool definitions via API
- **Budget awareness** funciona porque é WHAT ("you have 5 reads remaining"), não HOW


---

## Resumo Visual — Estrutura de um System Prompt

Ordem recomendada de secções num system prompt optimizado:

| # | Secção | Propósito |
|---|---|---|
| 1 | COMPLETION RULE (primacy) | Regra crítica no início |
| 2 | ROLE + CONTEXT | Quem é, porquê |
| 3 | OUTPUT FORMAT | Estrutura exacta |
| 4 | CONSTRAINTS (contrato) | Regras vinculativas |
| 5 | FEW-SHOT EXAMPLES | 3–5, diversos, tagged |
| 6 | TASK-SPECIFIC RULES | Regras do domínio |
| 7 | SAMPLING PARAMS | Temperature, top_p, documentados |
| 8 | LENGTH CONTROLS | Budgets por secção |
| 9 | ERROR RECOVERY | Protocolo de self-correction |
| 10 | REMINDER (recency) | Repetição da regra crítica |

---

### Sources

- platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices
- anthropic.com/engineering/effective-context-engineering-for-ai-agents
- platform.openai.com/docs/guides/prompt-engineering
- cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide
- aclanthology.org/2025.findings-acl.52.pdf
- arxiv.org/abs/2507.13949
- lakera.ai/blog/prompt-engineering-guide
- palantir.com/docs/foundry/aip/best-practices-prompt-engineering

