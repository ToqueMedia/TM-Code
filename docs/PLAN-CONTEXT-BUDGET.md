# Orçamento de contexto — onde estamos e o que falta medir

> **Documento de handoff.** Escrito para ser lido numa sessão NOVA, sem
> histórico nenhum. Data: 2026-08-07. Repo: `exodus-ide` (IDE TM Code).
>
> **DECISÃO (2026-08-07): não se microcompacta.** O defeito passou a `off` —
> modelo cli-vaz. A válvula é a auto-compactação, seguida da recuperação de
> ficheiros/skills (`contextManager.buildPostCompactRecoveryBlock`).
>
> **A matriz abaixo NÃO contradiz isto, e é importante perceber porquê.** Ela
> deu vantagem ao `always` (10/10 contra 6/10 e 1/3) — mas correu com uma
> janela efectiva pequena. As personas declaram **1M**
> (`PERSONA_*_CONFIG_JSON.contextWindow`): a esse tamanho o orçamento é
> `min(980K × 30%, 250K)` = **250.000 tokens**, e a fixture de oito ficheiros
> (~80K de tool results) nunca lá chega — **`always` e `off` seriam o mesmo
> braço**. O que a matriz mediu foi o regime de janela apertada. Continua
> válido para esse regime; não descreve o de produção.
>
> **Cabo solto que ficou por puxar:** se a janela em runtime fosse 1M, o
> orçamento nunca teria disparado — e disparou 1–2 vezes por corrida em TODAS
> as células. Ou a janela não estava a resolver a 1M (cadeia
> `byok → header → persona → perfil → fallback 200K`), ou há aqui outra coisa.
> Isto importa para além do orçamento: se a janela é sub-lida, a
> **auto-compactação** também dispara cedo de mais — e essa é agora a única
> válvula. O `result` dos evals não regista a janela efectiva; registá-la é o
> primeiro passo para resolver.

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

A ressalva de então — **n=3, uma corrida de diferença** — ficou resolvida pela
matriz abaixo, que levou o A e o C a n=10 (dois modelos × 5).

## O braço C: MEDIDO e REFUTADO (2026-08-07)

Orçamento por GATILHO: manter o orçamento mas só o accionar perto do limiar de
compactação (a 95% dele), em vez de a cada pedido. Era "a hipótese a bater".
Não bateu — perdeu nos dois modelos.

| célula | modelo | n | correcto | marcos | **compactações** | in/pedido | seg |
|---|---|---|---|---|---|---|---|
| standard/**always** | mimo-v2.5-pro | 5 | **5/5** | 2 | **0** | 46 894 | 58 |
| standard/trigger | mimo-v2.5-pro | 5 | 4/5 | 1 | 1 | 54 146 | 63 |
| expert/**always** | glm-5.2 | 5 | **5/5** | 2 | **0** | 57 157 | 65 |
| expert/trigger | glm-5.2 | 5 | **2/5** | 1 | **5** | 46 203 | 82 |

**A ler pela coluna das compactações, não pelo p-value.** Segurar o orçamento
deixa o prompt crescer até a auto-compactação disparar: 5 compactações em 5
corridas no `expert/trigger`, ZERO em ambos os `always`. É o mesmo mecanismo
que afundou o braço B — **o braço C é um braço B mais lento**. O p ≈ 0,04 (uma
cauda, 10/10 vs 6/10) é sugestivo; o mecanismo é que é prova.

**O número que ensina mais deste documento inteiro:** `expert/trigger` é **19%
MAIS BARATO por pedido** que `expert/always` — e acerta **2/5 em vez de 5/5**.
Mais barato e mais errado. Se a métrica desta experiência fosse consumo de
tokens, o braço refutado teria "ganho". A métrica é a CORRECÇÃO; o custo é
preço, não objectivo; e as releituras são diagnóstico, nunca alvo — perseguir
"zero releituras" leva por construção ao braço B, que é o pior de todos.

### O contador de releituras era cego a leituras por shell — CORRIGIDO

`standard/always` deu `[9, 0, 0, 5, 0]` releituras com `[8, 0, 0, 8, 0]`
ficheiros distintos. Os zeros com ZERO ficheiros não eram corridas limpas — eram
corridas em que o modelo leu por `tail`/`grep` e o contador (filtro `/read/i` +
`file_path`) não via nada. **Um zero de cegueira lê-se como o melhor resultado
possível**, e enviesa a comparação para o braço onde a cegueira calhar.

Corrigido em `runner/readAccounting.ts` (18 testes): conta leituras por tool
call COM `file_path` e por comando de shell, e atravessa as duas vias (ler com
`Read` e voltar com `tail` é uma releitura). O resultado passa a levar
`shellReads` e `toolsUsed` — a mistura de ferramentas fica auditável, em vez de
um total em que se tem de acreditar.

**Ponto cego residual, por desenho:** `Grep`/`search_files` recupera conteúdo
sem nomear um ficheiro (`query` + `directory`), portanto não há a quem atribuir
a leitura. Não é corrigível sem inventar atribuição — mas aparece em
`toolsUsed`. Medido no controlo de 07-08: `{"Read":13,"Grep":1,"Write":1}` com
8 ficheiros distintos e 5 releituras.

**As tabelas acima foram medidas com o contador ANTIGO.** A correcção e o
input/pedido — que decidiram a experiência — não têm este ponto cego; a coluna
das releituras dessas tabelas tem, e deve ler-se como um limite inferior.

## O que falta medir

1. O `compaction-survives` nos mesmos braços (só correu no A).
2. A lacuna do `readFileState` (secção no fim) — a única hipótese viva.

## Como correr

Braço e persona são **knobs de RUNTIME** (env do BINÁRIO, `TM_RUN_KNOB_*`, via
`runner_get_job`), não env de build. Consequência prática: **corre com o teu
`yarn dev` vivo** — o mesmo vite serve braços e personas diferentes.

```bash
# A — defeito, o que está em produção (avalia em todos os pedidos)
yarn evals:agent --only context-loss-rereads

# C — REFUTADO; só para reproduzir
EVALS_TOOL_RESULT_BUDGET_MODE=trigger EVALS_TOOL_RESULT_BUDGET_TRIGGER_PCT=95 \
  yarn evals:agent --only context-loss-rereads

# B — modelo cli-vaz, o pior dos três
EVALS_TOOL_RESULT_BUDGET_MODE=off yarn evals:agent --only context-loss-rereads

# trocar de MODELO: standard=mimo-v2.5-pro · expert=glm-5.2 · master=qwen3.8-max
EVALS_PERSONA=expert yarn evals:agent --only context-loss-rereads

# instrumento ortogonal, este AINDA é env de BUILD (lido na resolução do
# módulo): exige a :1420 livre, e o script ABORTA se não estiver
EVALS_AUTOCOMPACT_PCT=35 yarn evals:agent --only compaction-survives
```

O gatilho compara a ocupação resolvida (real ancorado + estimativa do que veio
depois) com **o mesmo limiar que a auto-compactação usa** —
`resolveAutoCompactThreshold`, não uma conta paralela. 75% e não 100% porque a
ocupação ancora no `prompt_tokens` do turno anterior: os tool results do turno
corrente ainda não estão contados, e acordar em cima do limiar chegaria tarde
para evitar a compactação, que é a única coisa que o braço C existe para evitar.

**Antes de interpretar QUALQUER export**: confirma `compaction.budgetMode`,
`compaction.persona` e `compaction.modelName` no `result` — o braço, a persona
e o modelo que REALMENTE correram, lidos do processo, não do que o operador
julga ter pedido. Um `--json` cujo par não é o que pediste é uma corrida
INVÁLIDA, não um resultado degradado.

Isto não é zelo: a 07-08, com estes botões ainda em env de BUILD, **12 corridas
(2 braços × 2 personas) mediram todas `always/standard`** porque um vite alheio
ocupava a :1420 e foi silenciosamente reutilizado. Foi o `budgetMode` no result
que o apanhou. Duas correcções desde então: os botões passaram a runtime (o
problema deixou de poder existir) e, para o que ainda é env de build, o script
**ABORTA** em vez de avisar — um aviso é uma linha de texto que se filtra sem
dar por isso, e foi exactamente assim que aconteceu.

## As referências, minadas

| | quando limpa tool results | preserva |
|---|---|---|
| **cli-vaz** | `enabled: false` por defeito. Ligado, dispara por TEMPO: 60 min sem resposta (a cache do servidor já expirou) | `keepRecent: 5` |
| **grok-build** | só dentro da compactação, como degradação por etapas, e só o que sozinho excede o orçamento | truncatura in-place para resultados "oversized" |
| **TM Code** | **em TODOS os pedidos**, por tamanho (30% da janela) | `keepRecent: 4` |

O TM Code é o único a limpar sempre. Mas — e isto é o mais importante deste
documento — **a medição direta deu razão ao TM Code**, não à referência. É a
primeira vez nesta sessão que isso acontece, e é por isso que a medição existe.

## A lacuna que sobra: o cli-vaz não resolve isto, EVITA-o

Lido na árvore de referência (`~/dev/cli-vaz`) a 2026-08-07:

- `readFileState` / `FileStateCache` — o **conteúdo** de cada ficheiro lido,
  guardado FORA do histórico de mensagens.
- `getChangedFiles` (`utils/attachments.ts:2063`) corre **em todos os turnos**
  sobre esse cache: compara `mtime` com o que o modelo viu e re-injecta o
  ficheiro alterado como attachment. O modelo nunca pede.
- `createPostCompactFileAttachments` (`services/compact/compact.ts:1414`)
  restaura os N ficheiros mais recentes depois de compactar. O comentário no
  código é literal: *"This prevents the model from having to re-read files that
  were recently accessed."*
- Quando limpa mesmo, deixa MENOS que nós: `'[Old tool result content cleared]'`
  (`microCompact.ts:36`), sem dica de releitura — mas só ao fim de 60 min de
  intervalo, quando a cache do servidor já morreu de qualquer forma.

**A diferença estrutural:** lá, o conhecimento dos ficheiros não depende de os
tool results sobreviverem no histórico; é a harness que re-hidrata, por
iniciativa própria, sem gastar um turno do modelo.

O TM Code **tem** o mesmo cache portado — `toolExecutor/fileStateCache.ts`, com
conteúdo, LRU de 25 MB — e usa-o para dedup e para resume. **Não o usa para
desfazer o que o orçamento evictou.** Em vez disso deixa uma nota a dizer "relê
via read_file", e o modelo gasta um turno inteiro (output + ida e volta + uma
passagem nova por TODO o histórico, ~47K de input nesta fixture) para receber
bytes que a IDE já tem em memória.

**Ressalva, para isto não ser vendido por mais do que vale:** no caminho do
ORÇAMENTO, evictar e re-injectar o mesmo seria um no-op — não poupava nada. A
re-injecção do cli-vaz vive depois da COMPACTAÇÃO, onde a poupança vem do
sumário. O que se transporta não é a re-injecção literal; é a doutrina de que o
**turno de releitura é evitável**, porque os bytes já cá estão. Isso não é
poupar contexto — é eliminar VIAGENS, e é a única coisa vista nesta sessão com
potencial para melhorar correcção, custo e latência ao mesmo tempo em vez de
trocar umas pelas outras. **Não medido. Exige desenho, não cópia.**

## O que NÃO fazer

- **Não reintroduzir o aparo por pedido sem uma janela pequena publicada.** A
  vantagem medida do `always` vale no regime de janela apertada; com 1M o
  tecto de 250K não é atingido e o aparo só reescreve o prefixo. `always` e
  `trigger` continuam por knob para o dia em que um modelo pequeno entre no
  catálogo.
- **Não optimizar tokens.** `expert/trigger` foi 19% mais barato por pedido e
  acertou 2/5 contra 5/5. A métrica é a correcção.
- **Não comparar dois `--json` sem olhar ao `persona`/`modelName`.** Todos os
  números anteriores a 07-08 foram tirados em `standard`/`mimo-v2.5-pro` e
  nenhum o diz — o runner fixa `standard` desde a "ronda-2 #11". A conclusão do
  braço B é uma afirmação sobre AQUELE sumarizador: a compactação é escrita
  pelo modelo do loop principal (igual no cli-vaz — `mainLoopModel`, nunca um
  Haiku dedicado).
- **Não mexer em `TOOL_RESULT_BUDGET_PCT` nem em `DEFAULT_KEEP_RECENT` por
  raciocínio.** São os parâmetros que governam tudo o que o modelo vê, e o
  `keepRecent` já se provou não ser a alavanca.
- **Não dizer ao modelo que está com pouco contexto** sem medir: o cli-vaz NÃO
  o faz (o `isAboveWarningThreshold` dele só alimenta UI), e avisar um modelo
  de que tem pouco espaço muda-lhe o comportamento de formas que ninguém
  testou aqui.

## Ficheiros

- `src/services/agent/toolResultGlobalBudget.ts` — o orçamento (`GLOBAL_TOOL_RESULT_BUDGET_TOKENS`, `DEFAULT_KEEP_RECENT`) **e o portão dos três braços** (`resolveToolResultBudgetMode`, `shouldApplyToolResultBudget`, `TOOL_RESULT_BUDGET_TRIGGER_RATIO`)
- `src/utils/contextWindow.ts` — `getToolResultBudgetTokens` (30%), `getAutoCompactThreshold`, e o override `VITE_AUTOCOMPACT_PCT`
- `src/services/agent/compact/autoCompact.ts` — `resolveAutoCompactThreshold` (exportada para o portão se posicionar contra ELA) e `resolveOccupancyWithSource`
- `src/services/agent/query.ts` (~1315) — o ponto de chamada, passo 0 do loop
- `src/services/agent/__tests__/toolResultBudgetMode.test.ts` — as propriedades de segurança do instrumento (defeito `always`, override inválido nunca desliga, sem sinal de pressão o `trigger` apara na mesma)
- `evals/README.md` — o protocolo, os controlos negativos e as armadilhas
- `evals/cases.json` — `context-loss-rereads`, `compaction-survives` (ambos `benchmark: true`)
