# Orçamento de contexto — onde estamos e o que falta medir

> **Documento de handoff.** Escrito para ser lido numa sessão NOVA, sem
> histórico nenhum. Data: 2026-08-07. Repo: `exodus-ide` (IDE TM Code).
>
> Se só leres uma coisa: **a experiência principal está desenhada, os dois
> primeiros braços correram, e a referência PERDEU.** Os números estão abaixo.
> Não repitas o braço B a pensar que é novidade.

## O achado

O developer reportou, várias vezes, que o indicador de contexto "ia para a
frente e recuava". Duas causas, e só a segunda é que interessa hoje:

1. **Bug de display, fechado** (`b385f6f`): `lastPromptTokens` tinha dois donos
   — o valor REAL do provider e um acumulador de estimativa que arranca em zero
   a cada run. A barra caía de 86% para 2% e voltava. Corrigido: a estimativa
   passou a ser monótona (`Math.max`), o real manda nos dois sentidos.

2. **O prompt oscila mesmo.** `applyGlobalToolResultBudget` corre em **TODOS os
   pedidos** e limpa o conteúdo de tool results antigos para manter o total
   abaixo de 30% da janela efectiva. O prompt fica preso a um tecto, em
   dente-de-serra. A barra a dançar era o sintoma; o estrago é o agente perder
   o que leu.

## O estrago, medido

Caso `context-loss-rereads` (benchmark; oito módulos, a soma exige as oito
constantes, o runner conta releituras):

| | A — orçamento por pedido (ACTUAL) | B — sem orçamento (modelo cli-vaz) |
|---|---|---|
| **correcto** | **2 de 3** | **1 de 3** |
| releituras | 5 (de 8 ficheiros) | **2** |
| marcos de orçamento | 2 | 0 |
| compactações | 0 | 1 |
| pior tempo | 65s | **129s** |

**Leitura:** o orçamento É a causa das releituras (caem para menos de metade
sem ele). Mas tirá-lo piorou o RESULTADO — sem o orçamento a aparar, o prompt
cresce até compactar, e a compactação é mais destrutiva que limpar tool
results antigos. Troca-se "releio cinco ficheiros" por "tenho uma narrativa da
conversa".

**`keepRecent` NÃO é a alavanca**: de 4 para 12 as releituras ficaram em 5. O
que prende é o orçamento em TOKENS — 8 ficheiros de ~1000 linhas são ~80K de
tool results contra um tecto de ~29,7K.

## RESSALVA que não se pode ignorar

**n=3 por braço.** 2/3 contra 1/3 é uma corrida de diferença. Nesta mesma
sessão houve DUAS decisões tomadas sobre amostras deste tamanho que se
revelaram ruído (ver `evals/README.md` → controlo negativo). Isto **indica**,
não conclui.

## O que falta medir (a sério)

1. **n ≥ 10 por braço** nos dois braços acima.
2. **Braço C, nunca corrido: orçamento POR GATILHO.** É o meio-termo que os
   números sugerem — manter o orçamento mas só o accionar perto do limiar, em
   vez de a cada pedido. A previsão é ficar com as releituras baixas do B sem
   a compactação precoce que o afundou. **É a hipótese a bater.**
3. O `compaction-survives` nos mesmos braços (só correu no A).

## Como correr

```bash
# instrumento: encurta o limiar de compactação (só encurta, ver contextWindow.ts)
EVALS_AUTOCOMPACT_PCT=35 yarn evals:agent --only compaction-survives

# o caso do estrago (não precisa de override)
yarn evals:agent --only context-loss-rereads
```

O braço B faz-se com uma linha em `query.ts` (guardar a chamada a
`applyGlobalToolResultBudget`). O braço C é a mesma chamada com uma condição
de ocupação em vez de `sempre`.

**Antes de interpretar QUALQUER export**: confirma que o vite de :1420 está
vivo e foi arrancado com as env que o caso precisa. É env de BUILD — um vite
já a correr não a ganha, e o caso passa a verde sem o mecanismo ter corrido.
Isso produziu dois falsos positivos nesta sessão.

## As referências, minadas

| | quando limpa tool results | preserva |
|---|---|---|
| **cli-vaz** | `enabled: false` por defeito. Ligado, dispara por TEMPO: 60 min sem resposta (a cache do servidor já expirou) | `keepRecent: 5` |
| **grok-build** | só dentro da compactação, como degradação por etapas, e só o que sozinho excede o orçamento | truncatura in-place para resultados "oversized" |
| **TM Code** | **em TODOS os pedidos**, por tamanho (30% da janela) | `keepRecent: 4` |

O TM Code é o único a limpar sempre. Mas — e isto é o mais importante deste
documento — **a medição direta deu razão ao TM Code**, não à referência. É a
primeira vez nesta sessão que isso acontece, e é por isso que a medição existe.

## O que NÃO fazer

- **Não copiar o cli-vaz nesta peça sem medir.** Já foi tentado (braço B) e
  perdeu.
- **Não mexer em `TOOL_RESULT_BUDGET_PCT` nem em `DEFAULT_KEEP_RECENT` por
  raciocínio.** São os parâmetros que governam tudo o que o modelo vê, e o
  `keepRecent` já se provou não ser a alavanca.
- **Não dizer ao modelo que está com pouco contexto** sem medir: o cli-vaz NÃO
  o faz (o `isAboveWarningThreshold` dele só alimenta UI), e avisar um modelo
  de que tem pouco espaço muda-lhe o comportamento de formas que ninguém
  testou aqui.

## Ficheiros

- `src/services/agent/toolResultGlobalBudget.ts` — o orçamento (`GLOBAL_TOOL_RESULT_BUDGET_TOKENS`, `DEFAULT_KEEP_RECENT`)
- `src/utils/contextWindow.ts` — `getToolResultBudgetTokens` (30%), `getAutoCompactThreshold`, e o override `VITE_AUTOCOMPACT_PCT`
- `src/services/agent/query.ts` (~1315) — o ponto de chamada, passo 0 do loop
- `evals/README.md` — o protocolo, os controlos negativos e as armadilhas
- `evals/cases.json` — `context-loss-rereads`, `compaction-survives` (ambos `benchmark: true`)
