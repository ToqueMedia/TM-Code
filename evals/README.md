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

## Custo — ler antes de correr em ciclo

Cada caso é um run REAL: chamadas ao modelo activo, tokens debitados no ciclo
(∼20-40k por caso com cache discount). A suite é curta de propósito; não é
para correr a cada save — é para validar mudanças à camada do agente antes de
um merge.

## Acrescentar um caso

Entrada em `cases.json`: `{ id, project (fixture), task, expect[] (regex,
case-insensitive, TODAS têm de bater no result.text), expectFiles[]
(têm de existir na fixture no fim), cleanupFiles[] (apagados antes do run),
timeoutSec }`. Fixtures novas vivem em `evals/fixtures/` — mínimas, com a
resposta certa no CONTEÚDO (nunca no nome do ficheiro), para obrigar o agente
a ler em vez de adivinhar.
