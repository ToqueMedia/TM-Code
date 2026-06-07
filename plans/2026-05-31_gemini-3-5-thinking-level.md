# Fix: Gemini 3.5 Flash `thinking_level` support

## Context

O proxy da API (`toquemedia-studio-api`) estava a enviar `thinkingConfig` (parâmetro de topo) para o Gemini 3.5 Flash, que não suporta esse campo — retornava `400 INVALID_ARGUMENT: Unknown name "thinkingConfig"`. Corrigimos para usar `thinking_level` dentro de `generationConfig`, que é o formato nativo do Gemini 3.5.x.

O utilizador confirmou que só pretende usar o Gemini 3.5 Flash (modelos anteriores como 2.5.x não são relevantes).

## Changes made

### `toquemedia-studio-api/src/geminiAdapter.ts`

1. **`thinking_level` dentro de `generationConfig`** (linhas 161-172):
   - Parâmetro: `thinking_level` (snake_case, não camelCase)
   - Localização: dentro de `generationConfig`, não como campo de topo
   - Valores: `'minimal'` | `'low'` | `'medium'` (default) | `'high'`
   - Mapeamento do `reasoning_effort` OpenAI → `thinking_level` Gemini:
     - `'high'` → `'high'`
     - `'medium'` → `'medium'`
     - `'low'` → `'low'`
   - Removido o bloco `THINKING_CAPABLE_MODELS` (2.5.x) e `thinkingConfig` (campo de topo)

2. **`finish_reason: 'tool_use'` quando há tool calls** (linhas 370-374 e 495-496):
   - Quando o modelo Gemini retorna `functionCall` parts, o `finish_reason` é mapeado para `'tool_use'` em vez de `'stop'`
   - Isto permite que o agent loop do frontend continue: envia tool results ao modelo e obtém resposta textual
   - Sem isto, o loop terminava prematuramente após a tool call sem gerar resposta

### `toquemedia-studio-api/src/proxy.ts`

- O proxy normaliza vários formatos de thinking (`enable_thinking`, `thinking`, `reasoning`, `thinking_budget`) para `reasoning_effort`
- O adapter converte `reasoning_effort` → `thinking_level` dentro de `generationConfig`
- Nenhuma alteração necessária no proxy — a lógica de normalização já funciona

## What was NOT changed

- `proxy.ts` — a normalização de thinking params já estava correcta
- Formato de tool calls na stream — já estava a converter correctamente `functionCall` → OpenAI `tool_calls`
- `toGeminiRequest()` — a conversão de messages (user, assistant, tool) já estava correcta

## Verification

- `npx tsc --noEmit` passa limpo em ambos os projectos
- Teste manual necessário: enviar "Hey" ao Gemini 3.5 Flash no modo CMD e verificar:
  1. Sem erro 400 na consola
  2. O modelo responde com texto (não fica mudo após tool call)
  3. Tool calls são executadas e resultados devolvidos ao modelo

## Architecture note

O Gemini 3.5.x usa um mecanismo de "Dynamic Thinking" que aloca compute automaticamente baseado na dificuldade da query. O `thinking_level` controla o orçamento:
- `minimal` → fastest, least reasoning
- `low` → low latency, basic reasoning
- `medium` → balanced (default)
- `high` → deepest reasoning, highest compute

Diferente do Gemini 2.5.x que usava `thinkingConfig: { thinkingBudget: N, includeThoughts: true }` como campo de topo.
