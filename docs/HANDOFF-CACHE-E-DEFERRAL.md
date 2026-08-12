# Handoff — cache, deferral de tools e economia dos planos

Escrito a 2026-08-12, no fim de uma sessão longa. Cobre só o que **não**
sobrevive nos commits nem nos comentários do código. Apagar quando estiver
feito.

O *porquê* de cada correcção já entregue está nos corpos dos commits e nas
notas longas do código — não é repetido aqui.

---

## 1. Deferral de tools nativas — RE-APLICADA (2026-08-12, 2ª tentativa)

**Feito.** Os cinco passos abaixo estão implementados; o resto desta secção
fica como registo do PORQUÊ da primeira tentativa ter falhado.

Medido no registo real: **−20 935 bytes de schema, +581 bytes de anúncio →
−20 354 líquidos, 41,8% do payload de tools** (15 diferidas, 27 carregadas).
Contra os −1,4% da primeira tentativa. A diferença inteira é *nomes-só*.

O que ficou:

- `SITUATIONAL_DEFERRED_TOOLS` (`toolPolicy.ts`) — a política num sítio só, em
  vez de `deferred: true` espalhado por 15 registos em 4 ficheiros. Aplicada
  por `applyNativeDeferral()` depois de tudo registado (os módulos de ops
  registam-se por último), com warn para nomes que não batem.
- `sharedDeferredToolsBlock()` — bloco ESTÁTICO, colado ao `getToolsSection`.
- `buildSystemPrompt`: o 8º parâmetro passou de `signals` a `options`
  (`{ hasImage, deferredToolNames }`) — o saco onde tudo o que for novo entra.
- Chave de cache: `df<nomes ordenados>` em `cacheKeyBase`. Os dois sítios
  ordenam, ou a mesma chave descrevia dois prompts.
- `sessionExport` passa os nomes (as MCP não — dependem de estado de sessão).

Evals: **5/5 verdes** (a suite por defeito; os 4 `benchmark: true` são opt-in).
Nenhum caso novo — ver abaixo.

### CORRECÇÃO: a premissa da secção seguinte estava ERRADA

Esta doc dizia que, sem anúncio, "o modelo não sabia que existiam, logo nunca
as podia pedir". **Não é verdade, e foi medido.** Sem o bloco de anúncio, o
modelo perguntado por ferramentas de worktree escreveu *"deixa-me verificar se
existem ferramentas diferidas relacionadas com git worktrees"* e **encontrou as
duas**: o def do `ToolSearch` é injectado sempre que existam diferidas, e a
busca por palavra-chave pontua contra as DESCRIÇÕES do índice.

Uma tool diferida sem anúncio é **descobrível**, não invisível. E, se o nome
for de treino (`WebFetch`), o modelo nem procura — chama-a às cegas e funciona,
porque diferir tira o schema mas não a registação.

Isto mata a ideia de um caso de eval para isto: qualquer tarefa do tipo "que
ferramentas tens para X" convida a uma busca e passa NOS DOIS estados. Três
probes tentadas, três sem dentes — a tabela está em `evals/README.md`, com a
única candidata que talvez tenha (`capture_url_design`).

**O anúncio continua a valer**, mas por outra razão: poupa a ida e volta da
descoberta. Com o bloco, 2 pedidos / 49 548 de input; sem ele, 3 pedidos /
72 823 (n=1 por braço).

### PROBLEMA EM ABERTO: o modelo não chama o `ToolSearch` quando tem o anúncio

3 corridas, zero chamadas. Com os nomes anunciados o modelo responde de cabeça:
nas worktrees escreveu *"como são ferramentas diferidas, vou buscar os
esquemas"* e a seguir descreveu os parâmetros **sem os ir buscar** — narração
sem acção. Sem o anúncio, procura (é como as encontrou acima).

Leitura possível, não confirmada: o anúncio dá-lhe confiança a mais. Sabe o
nome, infere o resto, e a inferência sobre parâmetros é onde ele inventa.

O que isto quer dizer para os 41,8%: **a poupança é real e a capacidade
mantém-se alcançável; a recuperação FIEL do schema não está provada.**

Três pistas, por ordem de custo:

1. **Ver se a deferral MCP alguma vez foi medida.** Mesmo caminho de código
   desde 2026-08-03 — pode ter o mesmo problema há mais tempo.
2. **O def do `ToolSearch` chega ao FIM do array** (`agentService.ts:751`),
   depois das 27 carregadas.
3. **Testar um prompt mais imperativo** no `sharedDeferredToolsBlock` (hoje:
   "Fetch the schemas you need"). Medir, não assumir — está documentado três
   vezes neste repo que prosa não fecha buracos de comportamento.

### Registo: porque a 1ª tentativa falhou

O `cli-vaz` difere tools nativas (não só MCP). A regra está em
`~/dev/cli-vaz/tools/ToolSearchTool/prompt.ts`, função `isDeferredTool`:

1. `alwaysLoad: true` → nunca difere (opt-out, verificado primeiro)
2. `isMcp: true` → sempre difere
3. `ToolSearch` → nunca (é preciso para carregar o resto)
4. `shouldDefer: true` → difere

Lá são **25 diferidas de 40**. Ficam sempre carregadas: `Agent`, `Bash`,
`Brief`, `FileEdit`, `FileRead`, `FileWrite`, `Glob`, `Grep`, `MCP`,
`McpAuth`, `PowerShell`, `REPL`, `Skill`, `Sleep`, `SyntheticOutput`.
Diferem-se: `WebSearch`, `WebFetch`, `TodoWrite`, `AskUserQuestion`,
worktrees, `LSP`, `Task*`, `Team*`, `ScheduleCron`, `SendMessage`,
`NotebookEdit`, planos, recursos MCP.

**O critério é: o ciclo de trabalho fica; o situacional difere-se.**

### Porque foi revertida

O TM Code implementa só a regra 2. Marquei 15 tools nativas como `deferred` e
as evals deram 5/5 — mas era falso verde:

`getDeferredToolIndex()` alimenta apenas (a) a decisão de acrescentar o
`ToolSearch` ao array e (b) a busca do bridge. **Nunca chega ao prompt.** Quem
anuncia nomes diferidos é a secção MCP (`sharedSections.ts:180`), que lista só
`mcp__servidor__tool`.

Resultado: as 15 tools ficaram sem schema **e sem anúncio**. O modelo não sabia
que existiam, logo nunca as podia pedir. As evals não apanharam porque nenhum
dos cinco casos usa `WebSearch`/`WebFetch`/`update_tasks`/`ask_user_question`.

### A rede que ficou

O modo de falha desta funcionalidade é **silencioso** — diferir sem anunciar
não parte nada, o modelo apenas nunca pede a tool. Por isso a rede é toda
sobre isso, e foi controlada negativamente (tirar o bloco → 2 testes vermelhos):

- **Nas evals, nada** — as três probes tentadas morreram no controlo negativo
  (ver acima e `evals/README.md`). O harness ganhou na mesma a asserção
  `expectTools`, hoje sem utilizador: é a única forma de distinguir "chamou a
  tool" de "disse que ia chamar", e foi ela que mediu o problema do
  `ToolSearch`.
- Três testes em `contextBuilder.test.ts`: os nomes entram no prompt estático,
  não aparecem quando a lista é vazia, e **mudar o conjunto invalida a cache**
  (o passo de risco).
- Cinco em `toolExecutor.test.ts`, sendo os principais o invariante de que todo
  o nome de `SITUATIONAL_DEFERRED_TOOLS` existe e ficou diferido — uma tool
  renomeada fica vermelha em vez de apenas escrever um warn — e o do
  `getAllToolDefinitions` (ver abaixo).

**Defeito apanhado ao rever isto:** um run **lightweight** (sub-agente) não
leva o `ToolSearch` (a injecção está atrás de `!this.lightweightOptions`), logo
o que não vier no schema à partida é INALCANÇÁVEL para ele. Com as nativas
diferidas, o fallback `options.tools || getToolDefinitions()` passou a entregar
um sub-agente sem 15 tools e sem via de as carregar — deferral a remover
capacidade em vez de a adiar. Corrigido com `getAllToolDefinitions()` (eager +
diferidas), que também repõe a verdade do contrato do tipo ("if omitted, uses
all tools"). Nenhum caller actual era afectado (o `/review` passa lista
explícita), mas o próximo que omitisse `tools` perdia-as em silêncio.

Nota de manutenção: os testes de CONTRATO das descrições passaram a ler
`allToolDefinitions()` (eager + diferidas) em vez de `getToolDefinitions()`.
Com deferral, este último é um SUBCONJUNTO, e um teste de descrição sobre ele
passaria por ausência — o mesmo modo de falha, um nível acima.

---

## 2. Produção está ATRÁS do código local

**Data-plane** (`ai-pass-through`): última versão em produção é `ad6f36d6`.
Não leva a **afinidade por sessão** nem o **factor de cache 0,43** — ambos
commitados localmente.

**Não deployei de propósito:** a árvore do worker tem trabalho não commitado
do developer (`pricing.ts` novo, `activeConfig.ts`, `headers.ts`,
`applyReasoningEffort.ts` — o metering 30/70). Um `yarn deploy` empurra isso
para produção no estado em que estiver.

**Control-plane**: `303ec3a3` em produção, alinhado.

**Sidecar de imagem**: o KV **local** foi corrigido à mão (path nativo
`/api/v1/services/aigc/multimodal-generation/generation` no host
`dashscope-intl.aliyuncs.com`). **Produção provavelmente ainda tem a URL antiga
do modo compatible** — republicar o slot pela consola de admin apontada a
produção. O preset do catálogo já está correcto e deployado.

---

## 3. Decisões de negócio em aberto

### MEDIDO 2026-08-12: o `x-session-affinity` NÃO FAZ NADA

Sonda directa ao Workers AI (sem o nosso worker, sem KV, sem IDE):
`scripts/cf-cache-probe-header.mjs` e `scripts/cf-cache-probe-key.mjs`. Modelo `@cf/zai-org/glm-5.2`, prefixo
estável de 35K tokens, braços intercalados e com prefixo próprio para não se
aquecerem um ao outro.

| braço | hits |
|---|---|
| header com chave estável | **16/26 (61,5%)** |
| sem header, ou chave ALEATÓRIA por pedido | **15/26 (57,7%)** |

O decisivo é a chave aleatória: se a afinidade encaminhasse, uma chave nova a
cada pedido espalhava tudo por instâncias e levava o cache a ~0. Deu 8/14,
indistinguível dos 9/14 da chave constante. **O header é ignorado no endpoint
OpenAI-compatible** — coerente com a doc, que só o documenta para REST e
binding.

Três consequências:

1. **O 25,2% → 54,6% atribuído à afinidade por utilizador não foi causado por
   ela.** Nem a degradação 1/5/9 runs. O que mexe é a forma da sessão
   (histórico a crescer, pausas, runs em competição), não a chave.
2. **A afinidade por SESSÃO (`65e0f61`) não vai salvar o Cloudflare.** Eu tinha
   levantado essa hipótese — que os 35% mediam a config antiga e o fix por
   deployar resgatava o provider. A medição diz que não: nenhuma variante de
   afinidade muda nada.
3. **Não é artefacto de medição.** O Workers AI devolve mesmo
   `prompt_tokens_details.cached_tokens` — o campo que o `usage.ts` lê. Essa
   hipótese está fechada.

### E os OUTROS caminhos? Testados os três. Nenhum chega perto dos 95%

A hipótese seguinte era boa: a doc só documenta a afinidade para REST nativo e
para o binding, e nós usamos REST **OpenAI-compatible**. Se o caminho nativo
funcionasse, valia a pena mudar — a 95% de cache o Cloudflare ficaria a
**$0,317/M** de input, ABAIXO dos $0,369 do DashScope. Testados os três
(`scripts/cf-cache-probe-native.mjs` + sonda descartável com binding):

| caminho | chave estável | chave aleatória/ausente |
|---|---|---|
| REST OpenAI-compat (`/ai/v1/chat/completions`) | 21/38 (55%) | 15/26 (58%) |
| REST nativo (`/ai/run/@cf/...`) | 8/12 (67%) | 6/12 (50%) |
| binding `env.AI.run` | 8/12 (67%) | 8/12 (67%) |

Agregado: **37/62 (60%) com afinidade estável contra 29/50 (58%) sem ela.**
A afinidade não faz diferença em caminho nenhum, e o **tecto anda nos 60-67%**
em todos. Os 95% do DashScope/z.AI não são alcançáveis por mudança de rota.

A leitura é arquitectural: nos vendors do modelo o cache é uma camada
partilhada; no Workers AI os tensores vivem na memória da INSTÂNCIA de GPU, e o
routing é probabilístico — a própria doc diz *"increasing the likelihood"*, não
garantindo. Nenhum header torna isso determinista.

CAVEAT: no binding passei a afinidade como opção `sessionAffinity`, nome que
INFERI (a doc não o mostra para o binding). Se o nome certo for outro, o braço
"constante" do binding é na prática um braço sem afinidade — o que não muda a
conclusão, porque os 67% dele já igualam o melhor de todos os outros.

Procurados relatos de terceiros com o mesmo sintoma: **não se encontrou nada** —
só a documentação da própria Cloudflare, cujo "increasing the likelihood" já é
a admissão.

O código da afinidade FICA (header ignorado é inócuo), mas **não se orçamenta
margem com ele**.

**DECISÃO (developer, 2026-08-12): aceita-se o tecto. O Cloudflare fica com
67% de cache assumidos** — não se persegue mais o número.

Consequência a não esquecer quando se mexer nos planos: a 67% o input efectivo
do CF é `0,33 × 1,40 + 0,67 × 0,26 = **$0,636/M**`, contra $0,369 do DashScope.
Continua a ser ~1,7× mais caro, e o factor de cache 0,43 do `08fdfcf` foi
calibrado contra sessões de ~95%. Se o CF servir tráfego a sério, a margem
projectada no §3 não se mantém sem recalibrar.

Nota sobre os números: a taxa base num ciclo apertado é ~58-64%; os 35% da
tabela abaixo vêm de uso real (histórico a crescer, pausas humanas). Os dois
são compatíveis — o meu ciclo é o melhor caso.

### Tirar o GLM-5.2/Cloudflare do Standard

Experiência controlada — mesmo modelo, mesmo prompt, três provedores:

| provider | cache | custo/M-prompt | margem no plano |
|---|---|---|---|
| DashScope | 95,0% | $0,369 | **+26,4%** |
| z.AI | 95,2% | $0,381 | +24,2% |
| Cloudflare | **35,0%** | $1,090 | **−55%** |

O Cloudflare é o único que dá prejuízo. E a causa **não é nossa**:
`promptPrefixHash` idêntico nos três, prompts do mesmo tamanho, zero quebras de
prefixo. Nos outros dois o padrão é um miss inicial e depois tudo hits; no
Cloudflare os misses estão espalhados (11 em 17). A doc do Workers AI promete
*"increases the likelihood"*, não afinidade — e a probabilidade medida é ~35%.

Amostra pequena (17 pedidos). Vale confirmar com outra sessão antes de fechar.

### DashScope vs z.AI

O DashScope é mais barato e tem melhor margem (+26,4% vs +24,2%). Se a escolha
for entre os dois, é o DashScope.

### Medir o cache MÉDIO da base

**É o número que decide tudo.** Os 95% vêm de sessões longas e contínuas (uso
de desenvolvimento pesado). Um utilizador com muitos chats curtos tem menos
cache e custo por token faturável mais alto:

- a 95% de cache, o factor 0,43 dá **24% / 22% / 21%** de margem
- a 85% daria **~17%** no Vibe

Sem esse número, as margens acima são projecção, não plano.

### Contexto económico (para não se refazer a conta)

Planos: Vibe 13.000 Kz / 11M, Pro 32.500 / 28M, Max 130.000 / 114M.
Câmbio: compra a **1.163,81**, venda a **1.300,00** → **+11,7%** de receita
real que não aparece no preço nominal. É a variável mais volátil do modelo —
se o oficial subir para 1.250, a margem cai para ~19% sem se tocar em nada.

O factor de cache é a unidade de conta, não generosidade: **baixá-lo obriga a
anunciar um número menor de tokens para entregar o mesmo trabalho.** A 0,15,
por exemplo, o Vibe teria de ser 4,4M em vez de 11M para manter 30%.

---

## 4. Duas coisas medidas que ficam como linha de base

**Performance** (perfil do Web Inspector, 23,4s): Chakra inclusivo caiu de
61,5% → 35,6% depois de içar os estilos constantes. O que sobra:
`get` 6,8%, `PromptTextarea:58` 10,4% (reflow forçado do auto-resize).

**Memória** — reaberto e fechado a 2026-08-12. Três coisas:

**1. A fuga NÃO estava corrigida.** O fix de `15d4ef1` tratou cinco call sites
e deixou de fora o **`syncDiffStatusByResultId`**, que é justamente o que o
fluxo de APROVAÇÃO chama (`acceptDiff` → sync → `removePendingDiff`). Os testes
cobriam só o descarte, portanto ficaram verdes com a fuga viva no caso normal —
um run de trabalho aprova diffs, não os descarta. Mesmo padrão de gémeos
dessincronizados de sempre. Corrigido, com testes para os dois caminhos e
controlo negativo (2 vermelhos sem o release). Corrigido de caminho um `changed`
partilhado entre mensagens na mesma função, que recriava toda a cauda da
conversa com identidade nova e conteúdo idêntico.

**2. O comando de medição estava ERRADO** e pode ter medido ruído:

```
ps -o rss= -p $(pgrep -f "WebKit.WebContent" | head -1)      # NÃO
node scripts/rss-webcontent.mjs                              # SIM
```

Os WebContent são XPC e ficam todos com `ppid=1`, logo não há laço com a app e
o `head -1` apanha um qualquer. Na máquina do developer apanhava um processo de
8,7 GB de **outra** aplicação. O WebContent da IDE identifica-se por ter aberto
`~/Library/Caches/toquemedia-studio/WebKit/` — é o que o script faz.

**3. Quantificado no HEAP, que é onde o mecanismo vive**
(`scripts/heap-diff-retention.mjs`): 40 diffs de 220 KB → **8,5 MB retidos
antes, 0,2 MB depois**. A retenção é 1:1 com o conteúdo editado (~0,21 MB por
diff de 220 KB), portanto uma sessão que edite ficheiros grandes acumula
exactamente o total de bytes tocados × 2 (old+new).

Duas armadilhas de medição que custaram tempo e ficam registadas:

- **RSS do WebContent não serve para isolar isto.** A primeira tentativa correu
  um run headless sobre um ficheiro de 450 KB e viu +1,2 GB — nada disso eram
  os diffs: 450 KB são ~112K tokens, portanto a LEITURA domina. O RSS mistura
  allocator do WebKit, modelos do Monaco, buffers de tool results e
  highlighting. Serve para o SINTOMA, não para a variável.
- **`'x'.repeat(n)` não custa heap.** O V8 tem representação compacta para um
  caracter repetido: 4,5M chars por `repeat` = 0,02 MB; os mesmos construídos
  linha a linha = 21,6 MB. A primeira versão da sonda mediu 0,1 MB para 8,6 MB
  de conteúdo e teria passado por "não há fuga".

**4. O +553 MB da abertura NÃO é fuga — é o preço fixo da IDE.** Medido com
instâncias próprias (`--open-project`, uma por braço, WebContent identificado
pelo cache):

| projecto | ficheiros indexáveis | RSS inicial → final |
|---|---|---|
| `evals/fixtures/hello-node` | ~5 | 152 → **653 MB** |
| `exodus-ide` | 88 591 | 140 → **769 MB** |

Entre um projecto de 5 ficheiros e um de 88 mil vão **116 MB**. Ou seja: abrir
QUALQUER projecto custa ~500-650 MB, e o tamanho quase não conta. Não é o
índice do QuickOpen (que já exclui `node_modules` e delega o varrimento ao
Rust com `respectGitignore`), não são as sessões, não são os diffs. É a
baseline de Monaco + Chakra + React + WebKit. Se ~600 MB de baseline é
aceitável, é decisão de produto — mas não se resolve com um fix de fuga, e
qualquer investigação futura que parta de "porque é que abrir custa meio giga"
deve começar por aqui em vez de repetir esta bissecção.

**5. Sobra um drift em REPOUSO de 3,7 MB/min** (0,22 GB/h; medido em janela de
4 min, com a IDE parada e SEM instrumentação a correr). Ao longo de ~18h dá
~4 GB, o que explica os 8,5 GB da instância anterior sem precisar de diffs.
**Este é o único item de memória por diagnosticar.**

**ARMADILHA DO OBSERVADOR, registada porque quase me enganou:** com um
amostrador a correr `lsof -nP -p <pid>` a cada 10 s contra o processo, a taxa
media **79 MB/min**. Parado o amostrador: 3,7 MB/min. Vinte vezes menos. Medir
memória com `lsof` em ciclo apertado perturba a medição — usar duas leituras de
`ps` espaçadas, e nada mais.
