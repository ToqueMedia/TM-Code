# #9 — Contexto auxiliar entregue inline sem relação com a tarefa

> **ESTADO: fechado a 2026-08-05.** A medição obrigatória foi feita (resultado
> na secção "Medição do conteúdo real", abaixo) e o portão de evidência do
> projecto está implementado. O que se segue mantém-se como registo do achado;
> a secção final descreve o que ficou em código.

> **Documento de handoff.** Escrito para ser lido numa sessão NOVA, sem
> qualquer histórico. Contém o achado, as medições, a doutrina que está em
> vigor (e porquê), a armadilha que já matou a tentativa anterior, e os
> portões de validação. Data: 2026-08-05. Repo: `exodus-ide` (IDE TM Code).

## O achado

Numa sessão real de 3 horas (114 pedidos, projecto de gestão hospitalar —
backend Express+Drizzle e frontend React), **cinco secções de `design_system`
mais `ui_patterns` e `vision.image_rules` foram carregadas em TODOS os 114
pedidos**, num trabalho maioritariamente de backend (schema, repositórios,
rotas, facturação) e sem uma única imagem.

Medições do `requestUsageLog` dessa sessão (constantes nos 114 registos):

| Campo | Valor |
|---|---|
| `auxiliaryContextTokens` | 4 290 |
| `auxiliarySavingsTokens` | 6 720 |
| `requestContextToolCalls` | 0 |
| `modelRequestedContextSections` | `[]` |

`auxiliaryLoaded` (14): `design_system.semantic_tokens`, `design_system.theme_config`,
`design_system.brand_palette`, `design_system.chakra_recipes`,
`design_system.component_patterns`, `ui_patterns`, `project.package_map`,
`project.entrypoints`, `agent_runtime.mcp_routing`, `agent_runtime.tool_profiles`,
`delivery.dev_server`, `delivery.build_scripts`, `delivery.git_status`,
`vision.image_rules`.

`auxiliaryOmitted` (8): `design_system.index`, `project.structure_overview`,
`project.symbol_index`, `project.structure_full`, `agent_runtime.memory_context`,
`delivery.changed_files`, `scaffold.workflow`, `project.docs_full`.

Repare-se na assimetria: entregou-se paleta de marca e receitas de Chakra a um
agente a mexer em SQL, e omitiu-se `project.structure_overview` e
`project.symbol_index` — que era o que a tarefa pedia.

## Onde vive o código

- `src/services/agent/contextBuilder/auxiliaryRegistry.ts`
  - `BOUNDED_INLINE_CONTEXTS` — a lista dos 12 ids entregues inline por defeito.
  - As definições `cx({...})` de cada secção, com `estTokens`, `whenToUse`,
    `whenNotToUse`, `sourceResolver`, `costTier`.
  - `PromptProfile` = `'default_task' | 'project_bootstrap' | 'vision'`.
- `src/services/agent/contextBuilder.ts` (~linha 645) — a selecção
  determinista e a heurística de perfil (um bit: há imagem → `vision`).
- Telemetria: `auxiliaryLoaded` / `auxiliaryOmitted` / `auxiliaryContextTokens`
  / `auxiliarySavingsTokens` / `requestContextToolCalls` /
  `modelRequestedContextSections` em `RequestUsageEntry` (`src/types/chat.ts`).

`estTokens` declarados das 12 inline: semantic_tokens 220, theme_config 220,
brand_palette 160, chakra_recipes 180, component_patterns 650, ui_patterns 350,
package_map 220, entrypoints 220, build_scripts 220, mcp_routing 600,
tool_profiles 180, image_rules 200.

## A doutrina em vigor (não a atropelar sem a entender)

A entrega inline foi uma decisão deliberada de 2026-08-03 ("full-delivery"),
documentada no cabeçalho de `BOUNDED_INLINE_CONTEXTS`. O raciocínio:

1. **A meia-entrega falhava em silêncio.** Antes, estas secções eram
   on-demand via `request_context`. Numa sessão medida (momenu-fact, 02-08)
   houve **0 chamadas a `request_context` em 34 pedidos** — ou seja, o modelo
   nunca pedia o que lhe faltava; simplesmente trabalhava pior sem o dizer.
   A sessão de 05-08 confirma o padrão: `requestContextToolCalls` = 0 nos 114.
2. **Com cache, o custo marginal é pequeno.** Com ~96% de cache-hit medido, o
   custo real de manter as secções no prefixo estável ronda ~10% do nominal.
   Na sessão de 05-08 o hit foi 96,4%, portanto os 4 290 tokens custam na
   prática ~1 700 tokens faturáveis por pedido (a cache é faturada a 50%).

Só ficam on-demand as secções **unbounded** (`project.structure_full`,
`project.docs_full`, `project.symbol_index`) e `agent_runtime.memory_context`
(duplicaria as secções estáticas de memória do prompt).

**Portanto o problema NÃO é "entregar inline é errado".** É que a lista é
FIXA e cega ao projecto: um repo sem Chakra e sem design system recebe na
mesma cinco secções de design system, em cada pedido, para sempre.

## A armadilha (o que matou a tentativa anterior)

Qualquer solução que volte a tornar secções condicionais tem de responder a
esta pergunta antes de ser escrita: **o que acontece quando a heurística erra
e omite algo que era preciso?** A resposta histórica foi "o modelo pede" — e
mediu-se que ele NÃO pede (0 chamadas em 34 e em 114 pedidos). Uma condição
mal calibrada não degrada com aviso; degrada em silêncio, que é o pior modo
de falha possível neste sistema.

Ver também `src/services/agent/contextBuilder/auxiliaryRegistry.ts`, nota de
07-29: *"é exactamente como um perfil morto continua a parecer vivo"* — a casa
tem histórico de mecanismos que parecem activos e não estão.

## Direcção sugerida (não é ordem; discutir antes de codificar)

O critério que parece defensável é **evidência do próprio projecto, não
inferência sobre a tarefa**:

- As secções de `design_system` e `ui_patterns` só entram se o projecto tiver
  design system detectável — Chakra/Tailwind/tokens nas dependências, ficheiro
  de tema, etc. Num backend Express puro, nenhuma delas tem conteúdo útil e é
  provável que os resolvers já devolvam quase nada (VERIFICAR: se
  `estTokens` são estimativas mas o resolver devolve vazio, o custo real pode
  ser muito menor que 4 290 e o achado perde peso — **medir primeiro**).
- `vision.image_rules` só faz sentido quando o modelo servido tem visão ou a
  sessão tem imagens. Hoje entra sempre.
- Nada disto deve depender de classificar a TAREFA (foi por aí que o Intent
  Router morreu, ver `default_task`, ex-`bugfix_local`): depender do
  PROJECTO é estável e verificável.

**Primeiro passo obrigatório: medir o conteúdo real.** Antes de mudar
selecção, instrumentar quantos tokens cada resolver devolve de facto neste
tipo de projecto. Se `design_system.*` já rende ~0 tokens num backend, o fix
certo é outro (não emitir cabeçalhos de secções vazias) e muito mais barato.

## Portões de validação

```bash
yarn build          # tsc — o gate de correcção do repo (não há lint)
yarn test           # Jest, 2260 testes à data deste documento
cd src-tauri && cargo check   # só se tocares em Rust (não deve ser preciso)
```

Testes relevantes já existentes: `src/services/agent/__tests__/auxiliaryRegistry.test.ts`,
`contextBuilder.test.ts`, `deadGateRewiring.test.ts`.

Medição fim-a-fim: exportar uma sessão (a exportação traz `requestUsageLog` +
`requestEfficiencyReport`) e comparar `auxiliaryContextTokens`,
`auxiliaryLoaded` e o cache-hit antes/depois, no MESMO tipo de projecto.

## Medição do conteúdo real (2026-08-05) — o primeiro passo obrigatório

A hipótese registada acima ("se os resolvers devolvem vazio num backend, o
achado perde peso") está **falsificada**. As seis secções em causa são texto
**estático**: não passam pelo projecto, logo não encolhem num repo sem design
system. Medido o corpo renderizado (`ceil(chars/3)`):

| secção | chars | tokens reais | `estTokens` declarado |
|---|---|---|---|
| `design_system.semantic_tokens` | 425 | 142 | 220 |
| `design_system.theme_config` | 302 | 101 | 220 |
| `design_system.brand_palette` | 203 | 68 | 160 |
| `design_system.chakra_recipes` | 200 | 67 | 180 |
| `design_system.component_patterns` | 2 591 | **864** | 650 |
| `ui_patterns` | 1 242 | 414 | 350 |
| **total** | | **1 656** | 1 780 |
| `vision.image_rules` (sem visão nativa) | 639 | 213 | 200 |

Dois efeitos secundários da medição:

1. Os `estTokens` escritos à mão desviam-se do real (−25% a +33%), e eram eles
   que alimentavam `auxiliaryContextTokens`. Uma telemetria de custo que não
   mede o custo faz a auditoria seguinte discutir o número errado — corrigido
   (`applyRenderedTokenCounts`).
2. Os 4 290 tokens do achado são a soma dos `estTokens` das 14 secções, não o
   custo real.

## O que ficou em código (2026-08-05)

Portão de **evidência do PROJECTO** — nunca inferência sobre a tarefa.
`src/services/agent/contextBuilder/projectEvidence.ts` (novo) detecta três
superfícies a partir do `package.json` e da árvore, e
`applyEvidenceOmissions` (em `auxiliaryRegistry.ts`) retira da entrega inline
o que a evidência não justifica:

| retido quando | secções |
|---|---|
| sem superfície de UI (sem dep de UI, sem `.tsx/.vue/.html/.css`, sem pasta `components/pages/client/…`) | `design_system.component_patterns`, `ui_patterns` |
| sem superfície de tema (sem ficheiro/pasta de tema, sem `tailwind.config`, sem dep de design system) | `design_system.semantic_tokens`, `.theme_config`, `.brand_palette` |
| Chakra não é dependência | `design_system.chakra_recipes` |
| a sessão ainda não teve imagem (pegajoso: uma imagem no turno 3 mantém as regras no turno 8) | `vision.image_rules` |

**A armadilha, respondida.** Três propriedades, cada uma com teste:

1. **Ausência de dados não é evidência negativa** — projecto vazio ou ilegível
   entrega tudo, como antes. Criar uma app de raiz é onde a linha de base de
   gosto mais vale; não pode nascer sem ela.
2. **O portão não é pegajoso** — é reavaliado a cada build e o `fsVersion` está
   na chave de cache, portanto no turno a seguir a escrever o primeiro `.tsx`
   (ou a instalar Tailwind) as secções voltam sozinhas.
3. **A omissão é auditável, não silenciosa** — as secções retidas aparecem no
   índice on-demand num grupo próprio, com a razão e um convite explícito a
   pedi-las, e o `request_context` lista-as (`omittedIds` vem de
   `selection.omitted`, portanto o meta-tool aceita-as mesmo). Vão também para o
   export: `evidenceOmittedSections` / `evidenceOmitReason` / `evidenceSignals`
   atravessam `payloadInspector` → `RequestUsageEntry` → `sessionExport`.

   **Peso honesto desta propriedade:** é uma garantia para quem AUDITA, não um
   mecanismo de recuperação. Está medido que o modelo não pede o que lhe falta
   (0 chamadas em 34 e em 114 pedidos) — não há razão para crer que passa a
   pedir só porque a linha está mais bem escrita. A segurança real vem de (1) e
   (2); esta serve para que, quando correr mal, se consiga ver porquê.

Os sinais são de propósito **generosos** (basta uma pasta `client/`, `web/`,
`templates/`): erram para o lado de entregar.

### Poupança esperada, sem exagero

| arquétipo | retido por pedido |
|---|---|
| backend/CLI/lib puro (Express+Drizzle, Go, Python sem templates) | ~1 869 tokens |
| app React sem sistema de tokens | ~591 tokens |
| app React + Tailwind, sem Chakra, sem imagem | ~280 tokens |

Nota honesta: **a sessão que motivou o achado era full-stack** (backend Express
+ frontend React), logo teria ficado no último caso — poupança modesta. É a
consequência aceite de depender do PROJECTO e não da TAREFA; o caso onde o
achado tem o peso todo é o do backend puro.

### Correcções vizinhas apanhadas pelo caminho

- `PackageSummary.detectionDependencies` (novo): união **não truncada** de
  deps + devDeps + deps de workspace, só para detecção. As listas renderizadas
  vêm cortadas a 15/10 — `hasFrameworkDeps` detectava a partir delas e dava
  falso negativo em qualquer projecto onde o framework caísse fora da janela
  (React na posição 16 = "site sem build", e o prompt injetava-lhe as regras
  erradas, calado).
- `project.package_map` e `delivery.build_scripts` deixam de emitir um
  cabeçalho seguido de `package summary: unavailable` em projectos sem
  `package.json` — o caso "não emitir cabeçalhos de secções vazias" que o plano
  previa.

## Análise crítica da primeira versão (mesma sessão, 2026-08-05)

Uma releitura da própria implementação apanhou três defeitos, todos já
corrigidos. Ficam registados porque o padrão é mais útil do que o bug.

1. **Falhava para o lado errado.** `buildFileTree` devolve
   `(Could not read project structure)` quando a leitura falha; a primeira
   versão lia isso como "projecto sem UI" e retinha as seis secções. Um erro
   transitório de I/O degradava o prompt em silêncio — exactamente o modo de
   falha que este achado existe para combater, reintroduzido pela correcção.
2. **A regra 1 não cobria o caso real.** `hasSourceFiles` era
   `ficheiros-fonte OU package.json existe`, portanto uma pasta acabada de
   criar com `npm init -y` contava como projecto feito e perdia a linha de base
   de UI no turno em que a app era gerada. **O teste da regra 1 passava** — usava
   `pkgSummary: null`, o caso fácil. Um teste que valida a regra como foi
   ESCRITA, e não como se COMPORTA, é pior do que nenhum: dá cobertura à
   afirmação errada. Hoje o critério é ficheiro-fonte na árvore OU ≥1
   dependência declarada (contar `scripts` não serve: o `npm init -y` já gera
   um).
3. **Uma afirmação sem implementação.** Este documento dizia que os campos de
   evidência iam para o export; iam para o objecto de selecção e morriam aí —
   o `payloadInspector` não os copiava. É o padrão "alegação sem implementação"
   que a auditoria de 07-29/30 já tinha catalogado nesta casa, cometido a
   escrever a correcção de um achado da mesma família. Agora atravessam mesmo,
   com a razão por secção.

Um quarto ponto foi corrigido por coerência: `savingsTokens` passou a somar os
`estTokens` das omitidas em vez de `totalAvailable − loaded`. Com o carregado
medido no corpo real e o total ainda em estimativas, a subtracção misturava as
duas unidades — e podia ficar negativa quando o corpo real excedia a
estimativa.

## Evals: ganho medido (2026-08-06)

Dois braços, mesmo instrumento (o custo foi instrumentado e depois
cherry-picked para a baseline), mesma persona — o runner headless força
`standard`. Baseline = `badefac`.

**Casos determinísticos** (ler package, compreender código, escrever ficheiro),
médias dos casos com cache quente nos dois braços:

| | baseline | agora | delta |
|---|---|---|---|
| verdes | 3/3 | 3/3 | — |
| input / pedido | 56 426 | 52 732 | **−3 693 (−6,5%)** |
| input não-cache (preço cheio) | 7 850 | 6 012 | **−1 837 (−23,4%)** |
| contexto auxiliar / pedido | 4 290 | 1 836 | **−2 454 (−57,2%)** |
| output | 236 | 236 | idêntico |

Previsto pelo modelo de custo: −2 454 (portão) −1 250 (índice removido) =
**−3 704**. Medido: **−3 693**. O ganho vem de onde a tese dizia.

**Caso de risco** `ui-page-no-ui-project` — pede-se UI a um projecto sem
superfície de UI, ou seja o braço novo gera a página SEM
`design_system.component_patterns` nem `ui_patterns`:

- **Qualidade: 10/10 corridas verdes** nos dois braços (n=6 baseline, n=4
  novo). A asserção é sobre o CONTEÚDO gerado — tratamento do estado vazio —
  com enunciado neutro que não o pede. A linha de base sobrevive ao portão
  porque `sharedUiBaselineReminder()` vai no lembrete final, incondicional, e
  a versão longa é que é retida.
- **Custo por pedido: −5,7%**, consistente com os casos determinísticos.
- **Custo total: +20,1%, e este número NÃO está resolvido.** O nº de pedidos
  variou 2-5 na baseline e 2-6 no braço novo (médias 3,2 vs 4,0); as
  amplitudes sobrepõem-se e as amostras são pequenas. Contra a hipótese de
  degradação: o output do braço novo é MENOR (1 863 vs 2 339 tokens de média),
  o que não é o que se vê quando um agente itera para corrigir. A favor de a
  levar a sério: o ponto estimado é pior e não há amostra que o feche.

### O que continua por fazer / por decidir

- **Fechar o nº de pedidos do caso de risco.** ~10 corridas por braço decidem
  se os 4,0 vs 3,2 são variância da tarefa ou perda real. Até lá, o ganho
  confirmado é POR PEDIDO; o total nesse cenário adversarial fica em aberto.
- **Sem verificação na app.** O detector foi sondado contra árvores realistas
  (incluindo a deste repo, que retém apenas `vision.image_rules`) e os evals
  correm o binário a sério, mas ninguém abriu a janela e olhou.
- **Dois detectores para a mesma pergunta.** `isVanillaWeb`/`hasFrameworkDeps`
  no `contextBuilder` e `detectProjectContextEvidence` respondem ambos a "que
  tipo de projecto é este" e podem divergir. Consolidar fica em dívida.
- **`detectionDependencies` só foi ligado a um dos consumidores.** O tier de
  compatibilidade em `chatSections.ts` (~l. 623) continua a detectar a partir
  das listas truncadas a 15/10 e tem a mesma classe de falso negativo.
- **`maxDepth: 2`.** Num monorepo cujo frontend viva abaixo do segundo nível, a
  evidência de UI depende só das dependências (incluindo as de workspace). Os
  sinais de pasta (`client/`, `web/`, `apps/`) cobrem o caso comum; um layout
  invulgar pode escapar.

## Contexto de fundo útil

- `CLAUDE.md` na raiz e `ARCHITECTURE.md` — arquitectura dos 4 componentes.
- A telemetria do TMS (`tmsContext.ts`) é um singleton carimbado em cada
  entrada do log: campos como `shellReadBlocked` e `symbolIndex*` são
  **cumulativos na run**, não por pedido. Contar entradas com a flag não conta
  incidentes (já documentado no tipo em `src/types/chat.ts`).
- Achados vizinhos desta mesma auditoria já corrigidos e fora de âmbito aqui:
  pill de contexto congelado (commit `f2c4ca4`), prazo suave dos sub-agentes e
  disciplina de contexto do Explore (`ea5b181`), mensagens de erro que
  induziam o modelo em erro (`9d5ab96`).
