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

## Acrescentar um caso

Entrada em `cases.json`: `{ id, project (fixture), task, expect[] (regex,
case-insensitive, TODAS têm de bater no result.text), expectFiles[]
(têm de existir na fixture no fim), expectFileContains{ficheiro: [regex]} e
refuteFileContains{ficheiro: [regex]} (asserções sobre o CONTEÚDO gerado — é
o que mede qualidade em vez de existência), cleanupFiles[] (apagados antes do
run), timeoutSec }`. `--only` aceita ids separados por vírgula.

**Enunciado NEUTRO nos casos de qualidade.** `ui-screen-react` e
`ui-page-no-ui-project` NÃO pedem tratamento do estado vazio: se ele aparecer
no ficheiro gerado, veio da linha de base de UI do prompt — que é justamente
o que se está a medir. Escrever "trata o caso de lista vazia" no enunciado
transformaria o eval numa verificação de obediência, não de contexto.

`ui-page-no-ui-project` é o CASO DE RISCO do portão de evidência: pede UI a um
projecto que não tem superfície de UI nenhuma, portanto o portão retém
`design_system.component_patterns` e `ui_patterns`. É onde uma degradação
apareceria primeiro. Fixtures novas vivem em `evals/fixtures/` — mínimas, com a
resposta certa no CONTEÚDO (nunca no nome do ficheiro), para obrigar o agente
a ler em vez de adivinhar.
