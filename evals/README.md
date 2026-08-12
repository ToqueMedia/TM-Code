# Evals do agente (task F1-7)

A régua mecânica do objectivo "mesmo patamar que o cli-vaz ou superior": cada
caso arranca o TM Code em **modo runner headless** (`TM_RUN_*`), dá-lhe uma
tarefa real numa fixture, e valida o `result` NDJSON (texto por regex e/ou
ficheiros criados). Mudou-se o prompt, o executor ou o loop? Corre isto e a
resposta a "ficou melhor ou pior?" deixa de ser opinião.

## Correr

```bash
cd src-tauri && cargo build && cd ..   # binário de dev actualizado
yarn evals:agent                        # todos os casos
yarn evals:agent --only read-package    # um caso
```

- Se já houver um vite em `:1420` (ex.: `yarn tauri:dev:all`), é reutilizado —
  e a rota AI é a desse processo. Sem vite vivo, o script arranca um com
  `VITE_AI_WORKER_URL` apontado ao worker de **produção** (override por
  `EVALS_AI_WORKER_URL`).
- Precisa da sessão TM Code autenticada nesta máquina (o runner herda-a).

## "CI" = gate local pré-merge (decisão de design)

Esta suite NÃO corre em CI hospedado, de propósito: cada caso gasta tokens
reais do ciclo e precisa de uma sessão TM Code autenticada — pôr isso num
runner do GitHub a cada PR seria pagar modelo por push e provisionar
credenciais de produto num terceiro. O gate é LOCAL e disciplinar: **mudou a
camada do agente (services/agent, host, runner, prompt)? `yarn evals:agent`
verde antes do merge.** A regra vive no TMS.md (Agent Rules); CI hospedado
fica como evolução futura se um dia houver auth de service-account dedicada.

## Custo — ler antes de correr em ciclo

Cada caso é um run REAL: chamadas ao modelo activo, tokens debitados no ciclo
(∼20-40k por caso com cache discount). A suite é curta de propósito; não é
para correr a cada save — é para validar mudanças à camada do agente antes de
um merge.

## Medir GANHO ou PERDA (não só verde/vermelho)

Verde só diz que não partiu. Quando a mudança é no prompt/contexto, a pergunta
é se ficou mais barato ou mais caro — e o `result` do runner carrega agora o
custo REAL do provider (pedidos, input, cache-read, output, e o contexto
auxiliar por pedido). `--json <ficheiro>` grava a corrida para comparar.

Protocolo dos dois braços (usado no achado #9, 2026-08-06):

```bash
yarn evals:agent --json /tmp/new.json                 # o código com a mudança
git checkout -b eval-baseline <commit-antes>
git cherry-pick <commits-do-instrumento>              # MESMO instrumento nos dois braços
yarn evals:agent --json /tmp/baseline.json
git checkout main && git branch -D eval-baseline
```

Três armadilhas que já mordem:

1. **O vite de :1420 é REUTILIZADO.** É ele que serve o código ao binário —
   por isso o braço baseline mede-se trocando a ÁRVORE (`git checkout`), não
   arrancando um segundo vite noutra porta: o binário carrega :1420 na mesma.
2. **A primeira corrida apanha cache fria.** Comparar totais com um braço frio
   inflacionou um ganho de 23% para 47%. Descartar o primeiro caso ou
   comparar só casos com cache quente nos dois braços.
3. **Normalizar por PEDIDO.** O nº de turnos varia entre corridas do MESMO
   código (medido: 2 a 5 pedidos na mesma tarefa). O total é ruidoso; o
   input/pedido é a régua estável do custo do prompt.

## Forçar uma compactação num eval

A compactação e o orçamento de contexto foram, até 2026-08-07, as peças MENOS
cobertas — os casos são curtos e nunca chegam perto do limiar. Todos os
defeitos desse lado foram descobertos por exports de sessões reais do
developer, horas depois de terem sido entregues.

`VITE_AUTOCOMPACT_PCT` (porte de `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` do cli-vaz)
encurta o limiar para uma percentagem da janela efectiva. Só ENCURTA — um
valor mal posto antecipa a compactação, nunca a adia.

```bash
# fecha o vite primeiro: é env de BUILD, um vite já vivo não a ganha
EVALS_AUTOCOMPACT_PCT=15 yarn evals:agent --only <caso>
```

O runner avisa quando o override foi pedido e o vite já estava a correr sem
ele — sem esse aviso, o caso passava a verde sem nunca ter compactado, que é
precisamente o tipo de falso positivo que este ficheiro documenta três vezes.

### `compaction-survives` (benchmark)

O caso que fecha a lacuna. A fixture `long-session` tem três módulos de ~1000
linhas com uma constante no FIM de cada um; a tarefa exige lê-los todos e somar
as três — a soma só se sabe tendo lido os três, e o ficheiro final prova-o.

```bash
EVALS_AUTOCOMPACT_PCT=35 yarn evals:agent --only compaction-survives
```

`expectCompaction: true` faz o caso EXIGIR que a compactação tenha corrido
(`compaction.boundaries > 0` no result). Verificado nos dois sentidos a
2026-08-07:

| | resultado |
|---|---|
| com `EVALS_AUTOCOMPACT_PCT=35` | ✅ 1 compactação, 3 msgs sumarizadas, total correcto |
| **sem override** | ❌ `compactação exigida mas boundaries=0` |

O segundo é o que interessa: sem ele, o caso passaria a verde sem o mecanismo
ter corrido — que foi como dois hooks e um detector foram entregues "a
funcionar" neste repo antes de alguém medir.

### `context-loss-rereads` (benchmark)

Mede o ESTRAGO do orçamento de tool results — a peça que faz o prompt oscilar.
Oito módulos, a soma exige as oito constantes no fim, e conta-se quantas vezes
o agente teve de RELER o que já tinha lido.

```bash
yarn evals:agent --only context-loss-rereads
```

Linha de base medida a 2026-08-07 (orçamento 30% da janela, `keepRecent = 4`):

| | |
|---|---|
| releituras | **5 de 8 ficheiros** |
| marcos de orçamento | 2 |
| input | 250K–413K por corrida |
| correcção | **1 falha em 3** — total errado |

A falha é a parte que interessa: o estrago não é só custo, é resposta errada.

O contador de releituras cobre tool calls com `file_path` **e** comandos de
shell (`readAccounting.ts`), e atravessa as duas vias. Até 07-08 só via a
primeira, e uma corrida que lesse oito ficheiros com `tail` era reportada como
`0 releituras de 0 ficheiros` — indistinguível de uma corrida perfeita. O
`result` leva agora `shellReads` e `toolsUsed`: **um `distinctFilesRead` a zero
numa tarefa que exige leituras é cegueira, não limpeza.** `Grep`/`search_files`
continua sem atribuição possível (não nomeia um ficheiro) — vê-se em
`toolsUsed`.

`keepRecent` NÃO é a alavanca — subi-lo de 4 para 12 deixou as releituras em 5.
O que prende é o orçamento em TOKENS: 8 ficheiros de ~1000 linhas são ~80K de
tool results contra um tecto de ~29,7K, portanto ~63% tem de sair haja o
`keepRecent` que houver.

### Trocar de braço sem editar código

`EVALS_TOOL_RESULT_BUDGET_MODE` escolhe QUANDO o orçamento corre:
`always` (defeito, o que está em produção) · `trigger` (só a 75% do limiar de
compactação, afinável com `EVALS_TOOL_RESULT_BUDGET_TRIGGER_PCT`) · `off` (o
modelo do cli-vaz, medido como pior).

```bash
EVALS_TOOL_RESULT_BUDGET_MODE=trigger yarn evals:agent --only context-loss-rereads
```

É env de BUILD, com a armadilha do costume — mas agora o `result` diz que braço
correu de facto (`compaction.budgetMode`, impresso na linha do caso). Um export
cujo `budgetMode` não é o braço que pediste é uma corrida inválida: o vite de
:1420 estava vivo e serviu o bundle antigo. Um valor desconhecido cai em
`always` de propósito — um override mal escrito não pode desligar em silêncio o
único tecto do prompt.

Referências, para contexto: o cli-vaz tem o microcompact DESLIGADO por defeito
(`enabled: false`) e, ligado, dispara por TEMPO — 60 min sem resposta, quando
a cache do servidor já expirou de qualquer forma. O grok-build só trunca dentro
da compactação, como degradação por etapas, e apenas o que sozinho excede o
orçamento. Nenhum dos dois limpa a cada pedido.

### Deferral de tools: TRÊS probes tentadas, TRÊS sem dentes (2026-08-12)

Não há caso de eval para a deferral de tools nativas. **Não por esquecimento:
tentaram-se três e o controlo negativo matou as três.** Fica aqui o registo,
porque a conclusão é sobre o mecanismo, não sobre o harness — e sem isto a
quarta pessoa tenta a mesma coisa.

O ponto de partida era o do `docs/HANDOFF-CACHE-E-DEFERRAL.md`: uma tool
diferida perde o schema, e sem anúncio do nome o modelo "não sabe que existe,
logo nunca a pede". **Essa premissa está ERRADA**, e foi o controlo negativo
que o mostrou.

| probe | resultado sem o anúncio | porquê |
|---|---|---|
| `web_fetch` — título de `example.com`, `yolo:false` | **verde** | chamou `WebFetch` às cegas e acertou |
| `expectTools: [ToolSearch]` | vermelho SEMPRE (3/3) | o modelo nunca chama o ToolSearch |
| nomear as tools de worktree | **verde** | descobriu-as com o ToolSearch por palavra-chave |

1. **Diferir não impede executar.** O deferral tira o schema do pedido; a tool
   continua registada e a chamada às cegas corre (há um teste que o afirma:
   *"a execução de uma tool diferida continua registada e funcional"*). Com um
   nome de TREINO — `WebFetch` está em `ADVERTISED_TOOL_NAMES` por ser um nome
   que o modelo já sabe — ele adivinha-o e acerta nos parâmetros.
2. **Uma tool não anunciada é DESCOBRÍVEL.** O def do `ToolSearch` é injectado
   sempre que existam diferidas, e a busca por palavra-chave pontua contra as
   DESCRIÇÕES. Perguntando por worktrees sem o bloco de anúncio, o modelo
   escreveu *"deixa-me verificar se existem ferramentas diferidas relacionadas
   com git worktrees"* e encontrou as duas. Invisível, não é.
3. **Logo qualquer tarefa do tipo "que ferramentas tens para X" convida a uma
   busca** e passa nos dois estados. É por construção que estas probes não têm
   dentes.

**O que o anúncio vale, então** (n=1 por braço, indicativo): com o bloco, 2
pedidos / 49 548 de input; sem ele, 3 pedidos / 72 823 — **uma ida e volta de
descoberta a mais**. O ganho é essa ida e volta e a fiabilidade, não a
existência da capacidade.

Uma probe COM dentes teria de ser uma tarefa onde o modelo **não desconfia**
de que a capacidade existe (candidata: `capture_url_design` — pedir o aspecto
VISUAL de uma página; sem anúncio ele resolve com texto e nunca procura um
screenshot). Precisa de rede e browser, é lenta, e ninguém a mediu ainda.

Entretanto a rede é de testes unitários, em `contextBuilder.test.ts` — os
nomes entram no prompt estático, e mudar o conjunto invalida a cache. Esses
foram controlados negativamente e ficam vermelhos (2 de 3) sem o bloco.

**Nenhum caso usa hoje o `expectTools`** (a asserção que o harness ganhou nesta
tentativa). Ficou porque é a única forma de distinguir "chamou a tool" de
"disse que ia chamar" — foi ela que mediu o ponto 2 acima. Se daqui a uns meses
continuar sem utilizador, apagar.

## Acrescentar um caso

Entrada em `cases.json`: `{ id, project (fixture), task, expect[] (regex,
case-insensitive, TODAS têm de bater no result.text), expectFiles[]
(têm de existir na fixture no fim), expectFileContains{ficheiro: [regex]} e
refuteFileContains{ficheiro: [regex]} (asserções sobre o CONTEÚDO gerado — é
o que mede qualidade em vez de existência), expectTools[] (tools que TÊM de
ter sido chamadas; `a|b` = alternativa), yolo (false põe o run em read-only),
cleanupFiles[] (apagados antes do run), timeoutSec }`. `--only` aceita ids
separados por vírgula.

**Enunciado NEUTRO nos casos de qualidade.** `ui-screen-react` e
`ui-page-no-ui-project` NÃO pedem tratamento do estado vazio: se ele aparecer
no ficheiro gerado, veio da linha de base de UI do prompt — que é justamente
o que se está a medir. Escrever "trata o caso de lista vazia" no enunciado
transformaria o eval numa verificação de obediência, não de contexto.

`ui-page-no-ui-project` é o CASO DE RISCO do portão de evidência: pede UI a um
projecto que não tem superfície de UI nenhuma. É onde uma degradação apareceria
primeiro — e apareceu (2 falhas em 15, ver o doc do #9).

## CONTROLO NEGATIVO: um caso verde não prova nada

Um eval que nunca fica vermelho é decoração cara. Antes de acrescentar um caso
de qualidade, **apaga a regra que ele diz guardar e confirma que ele reprova**.

Feito a 2026-08-06, com `sharedUiBaselineCore()`, `sharedTasteDefaults()` E
`sharedUiBaselineReminder()` a devolver string vazia:

| caso candidato | resultado sem as regras | veredicto |
|---|---|---|
| estado vazio (`ui-page-no-ui-project`) | 1 falha em 3 | **tem dentes** — ficou |
| restrição/gosto (gradientes, lorem, emoji) | 5/5 verde | vácuo — **removido** |
| stack por defeito (sem Chakra/MUI) | 5/5 verde | vácuo — **removido** |

Os dois vácuos ensinam mais do que se tivessem passado despercebidos: o eval
citado no cabeçalho de `sharedSections.ts` (2026-05-23: "sem esta secção,
gradientes arco-íris e heróis gigantes 70% das vezes") **não reproduz** no
modelo servido hoje. Isso põe em causa os ~1 278 tokens/pedido de
`sharedUiBaselineCore` + `sharedTasteDefaults` — de tudo o que elas dizem, a
única propriedade que se conseguiu provar que carregam é o estado vazio.
Duas tarefas e dez corridas não são prova de que o resto é inútil; são prova
de que ninguém mediu. Fixtures novas vivem em `evals/fixtures/` — mínimas, com a
resposta certa no CONTEÚDO (nunca no nome do ficheiro), para obrigar o agente
a ler em vez de adivinhar.

## Hooks: a receita que fecha buracos de comportamento

Está medido três vezes neste repo que **prosa não fecha buracos de
comportamento** (ver `editDiagnostics.ts` e a nota em `sharedSections.ts`). Os
hooks (`src/services/agent/hooks.ts`, porte do cli-vaz) são a alternativa, e
2026-08-06 mediu o que valem:

| problema | sem hook | com hook |
|---|---|---|
| usa os design tokens do projecto | **37% de falha** (n=40) | **0 em 10** (Pre e Post) |
| trata a lista vazia | ~13% de falha | 10/10 **com ZERO rejeições** — o hook nunca disparou |

A diferença entre os dois não é acidente, e tem DOIS eixos:

1. **Projecto vs universal.** Tokens em `src/theme/` são deste repo; tratar o
   estado vazio é de qualquer UI. Um hook por projecto para uma regra
   universal obrigaria cada repo a reescrevê-la — a resposta do cli-vaz para
   essas é o prompt, que já a carrega (apagar `sharedUiBaselineCore` deu 8
   falhas em 10).
2. **Sintáctico vs semântico.** Um hook é `grep`. "hex em vez de `var(--`"
   está no texto ou não está. "esta colecção precisa de estado vazio" exige
   saber se ela pode vir vazia — e o detector que escrevi provou os dois lados
   da armadilha: bloqueava `TABS.map` sobre uma constante (falso positivo) e,
   corrigido isso, deixava passar o array declarado no próprio ficheiro (ponto
   cego), que é exactamente o que o caso pede. As 10/10 foram com **zero
   rejeições**: linha de base, não efeito.

`PreToolUse` com exit 2 impede a escrita; `PostToolUse` com exit 2 devolve o
resultado como ERRO (a escrita já está feita e não se desfaz, mas o modelo tem
de a corrigir). Os dois foram medidos a 0/10 no problema dos tokens — no Post,
com 3 rejeições reais que o modelo corrigiu. `additionalContext` (exit 0) é só
conselho e não muda comportamento: 5/10, igual a não haver hook.

**A capacidade é do developer, não só do código.** `hook-authoring`
(`benchmark: true`) pede em linguagem natural — *"quero que fique GARANTIDO,
não recomendado"* — sem dizer a palavra "hook", e verifica se o agente escreve
o `.toquemedia/hooks.json`. Medido a 2026-08-06: **5 em 6**. Foi o que provou
que a skill `hooks` torna a funcionalidade alcançável; sem ela, o developer
teria de ler o código-fonte da IDE para saber que existe.

Os dois modos de falha observados valem mais do que o número:
1. um `hooks.json` na RAIZ (perfeito, e silenciosamente ignorado) — porque a
   fixture tinha lá um `.example` que ensinou o sítio errado;
2. o agente a inventar `.tm/hooks/*.yaml`, ou a criar um git hook `.husky/`,
   em vez de ler a skill.

Ambos levaram a correcções: os exemplos passaram para `.toquemedia/`, a skill
diz que o caminho é load-bearing e distingue-se de git hooks, e o `hooks.ts`
regista um aviso quando encontra um `hooks.json` fora do sítio.

Exemplos prontos a copiar, nas fixtures:
`react-vite-tokens/hooks.json.example` + `check-tokens.sh.example` (recusa
cores cruas num projecto com tokens) e `hello-node/*.example` (recusa mapear
uma colecção sem estado vazio). Ficam como `.example` de propósito: activos,
os casos mediriam o hook em vez do agente.

Três coisas que custaram a descobrir e evitam repeti-las:

1. **`exitCode`, não `exit_code`** — o `CommandResult` do Rust vem em
   camelCase. Ler o nome errado fazia o exit 2 virar 1 e NENHUM hook
   bloqueava, silenciosamente.
2. **O agente contorna.** Bloqueado no `Write`, o trace mostrou-o a tentar
   `Bash`, `create_file` e `Edit`. Um matcher só com `Write` deixa a porta ao
   lado aberta.
3. **No PostToolUse de uma escrita, o ficheiro ainda não está no disco** — o
   `toolExecutor.execute` devolve um diff e a escrita acontece depois, na
   aprovação. Um hook com `[ -f "$FILE" ]` sai em silêncio: mediu-se 10/10 com
   um hook que não fazia NADA, e só o traço o revelou. Lê
   `tool_input.content`.
4. **Calibra o detector contra artefactos ANTES de o ligar.** A primeira
   versão do detector de estado vazio bloqueava um `map` sobre uma constante
   local — ruído que ensina a ignorar o canal, que foi como a primeira versão
   do `editDiagnostics` morreu. (E `sed 's/\(a\|b\)//'` é GNU: no BSD sed do
   macOS não corta nada e não dá erro.)
