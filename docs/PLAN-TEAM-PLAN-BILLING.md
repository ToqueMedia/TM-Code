# PLAN — Plano de Equipas (Billing: Pool partilhado + fatias hard-cap)

> **Status:** Proposta / **Track ativa**.
> **Decisões travadas (2026-06-16):** **hard cap estrito** por membro · **pie fixa por tier + top-ups**.
> **Relação com a Colaboração P2P:** independente (ver `PLAN-TEAM-COLLAB-P2P.md`).
> **Invariante a preservar:** contabilidade **exclusiva** do data-plane `ai-pass-through` (single source of truth). A IDE e a web só exibem.

---

## 1. Modelo (fechado)

- O admin compra um **plano de equipa** com um **tier** → orçamento base **B** em tokens = **100% da pie** (volume default do plano). Inicialmente `pieTotal = B`.
- O admin **distribui a pie em fatias**, retirando dos 100%: cada membro `i` tem `percentAllocation_i`. **O próprio admin é um membro com fatia** — pode reservar parte dos 100% para si.
- A parte não atribuída é a **reserva disponível** (`1 − Σ percentAllocation_i`, "a % que ainda resta a usar") — **não é "sobra" passiva**, é o pool que o admin gere ativamente.
- **Gestão dinâmica:** a qualquer momento o admin move % da reserva (ou baixando um membro ocioso, sem ir abaixo do já-consumido) **para qualquer membro OU para si mesmo** — em particular quando um membro esgota a fatia (é o desbloqueio do hard cap).
- **Hard cap estrito:** o membro é bloqueado ao atingir `percentAllocation_i × pieTotal`, **independentemente** de a equipa ter folga. Só o admin a aumentar a % o desbloqueia.
- **Top-up (consumos avulsos):** comprar **+X%** aumenta `pieTotal` (ex. 130% do base). **Não é um pool de overflow** — cresce a pie e o admin re-distribui a partir da reserva.
- Cada membro corre o **seu** agente com o **seu** JWT → o worker debita `members.{uid}` naturalmente (sem on-behalf-of).

**Consequências do hard cap estrito:**
- `Σ percentAllocation_i ≤ 1.0` ⇒ `Σ tetos ≤ pieTotal` ⇒ a equipa **nunca estoura a pie coletivamente**.
- **Não existe overage** em lado nenhum no modelo de equipa. O caminho de `extraUsageBalance`/`overageConsumed`/`allowed_overage` do per-user **não se usa**.
- `commitTokenConsumption` reduz-se a **dois incrementos** (total da equipa + `members.{uid}`), sem ramos.

---

## 2. Data model `teams/{teamId}` (coleção `teams` já reservada — `teamsRef`)

```
teams/{teamId}
  ownerUid: string
  name: string
  planTier: string                 // 'team-pro' | 'team-max' (planKey em subscription_plans → baseBudget)
  cycle:
    anchorDay: number              // 1–28; UM ciclo p/ toda a equipa
    cycleEnd: string               // ISO; membros herdam, ignoram anchor pessoal
  tokenBudget:
    purchasedExtra: number         // tokens comprados via +X% (cresce a pie). NÃO é overflow consumível
    tokensConsumed: number         // Σ membros no ciclo (o bolo consumido)
  lifetimeTokensConsumed: number
  members:
    {uid}:
      role: 'owner' | 'member'
      percentAllocation: number    // 0–1; Σ ≤ 1.0 (validado na escrita)
      tokensConsumed: number       // consumo do membro no ciclo
      blocked: boolean             // suspensão pelo admin

users/{uid}                        // modificação mínima
  activeTeamId?: string            // se definido → orçamento da equipa tem precedência; plano pessoal dorme
```

Derivados (não armazenados): `pieTotal = baseBudget(planTier) + tokenBudget.purchasedExtra`; `ceiling_i = percentAllocation_i × pieTotal`.

---

## 3. Data-plane — as 4 funções (`workers/ai-pass-through/src/billing.ts`)

### 3.1 `getUserBudgetState(uid)`
- Adicionar **`activeTeamId`** à field-mask do `users/{uid}`.
- Se `activeTeamId` definido → 1 GET extra a `teams/{teamId}` (mask: `planTier`, `cycle.*`, `tokenBudget.*`, `members.{uid}.*`). Cacheável 60s por `teamId`.
- Devolver estado aumentado:
  ```ts
  { isTeam: true, teamId, planTier,
    pieTotal,                 // baseBudget(tier) + purchasedExtra
    sliceTokens,              // ceiling_i
    memberConsumed,           // members.{uid}.tokensConsumed
    memberBlocked,            // members.{uid}.blocked
    cycleEnd }
  ```

### 3.2 `checkCostBudget(state)`
- Se equipa: `consumedPct = memberConsumed / sliceTokens` (thresholds 80/95/100 **sobre a fatia**).
- `memberBlocked` → 403 (reaproveita o gate de suspensão).
- `consumedPct ≥ 1.0` → **rejected** (`tm_team_slice_exhausted`). **Sem `allowed_overage`** (cap estrito).
- (Gate de total da equipa = rede de segurança redundante, dado `Σ tetos ≤ pieTotal`.)

### 3.3 `commitTokenConsumption(...)` — dual-write atómico, sem overage
- 3x multiplier aplicado a `raw` como hoje, **antes** do commit.
- Um `:commit` com transforms em dois docs:
  ```
  teams/{teamId}.tokenBudget.tokensConsumed   += raw
  teams/{teamId}.lifetimeTokensConsumed       += raw
  teams/{teamId}.members.{uid}.tokensConsumed += raw
  ```
- **Sem** decremento de `extraUsageBalance`, **sem** `overageConsumed`, **sem** floor. (Opcional: manter `users/{uid}.lifetimeTokensConsumed += raw` para trilho de auditoria pessoal.)

### 3.4 `resolvePlanBudgetFor(planTier)`
- Resolver `baseBudget` para o tier de equipa (reaproveita o lookup de `subscription_plans` por `planKey`, ex. `team-pro`/`team-max`; fallback hardcoded como hoje).
- `pieTotal = baseBudget + teams.{id}.tokenBudget.purchasedExtra` (purchasedExtra vem do doc da equipa lido em 3.1).

### 3.5 Headers (`headers.ts`)
```
x-team-id, x-plan (tier), x-budget-pct (slice%), x-budget-status,
x-tokens-consumed (membro), x-slice-tokens (ceiling_i), x-pie-total, x-cycle-end
```

---

## 4. Control-plane (`toquemedia-studio-api`)

- **`/v1/me`**: se `users/{uid}.activeTeamId`, incluir bloco `team`:
  ```json
  { "tier": "team-pro", "pieTotal": 27183000, "pieSizePct": 1.3,
    "mySlicePct": 0.2, "mySliceTokens": 5436600, "myConsumed": 1200000,
    "cycleEnd": "2026-07-16", "status": "allowed_warning" }
  ```
- **Reset/carry-over a nível de equipa** (`firestore.ts`): no roll do ciclo da equipa, repor `tokenBudget.tokensConsumed` **e** todos os `members.*.tokensConsumed` a 0. `carry = max(0, teamConsumed − pieTotal)` — só absorve o overshoot residual das corridas de cache (com cap estrito não há overage real). `purchasedExtra` mantém-se ou expira por política (decisão em aberto §8).
- **Nenhum endpoint novo obrigatório:** o dashboard lê `teams/{id}` direto via DAO (como já faz com `subscription_plans`); a IDE lê via `/v1/me`.

---

## 5. Web (monorepo `toquemedia-studio`) — dashboard + Functions

- **`TeamDAO`** novo (coleção `teams`), ao lado de `SubscriptionPlanDAO`/`CreditPackDAO`.
- **Tiers de equipa** em `subscription_plans` (`planKey: 'team-pro'|'team-max'`, `tokenBudget` = pie base).
- **Dashboard:**
  - **Pie chart** = `members[].percentAllocation` (divisão do bolo; soma 100%).
  - **Torres** = `members[].tokensConsumed` (consumo real por membro).
  - **Indicador de tamanho da pie** = `pieTotal / baseBudget` (ex. "Bolo: 130%").
  - **Gestão:** adicionar (convite por email — reusar infra de referral), remover, **bloquear** (`members.{uid}.blocked`), **realocar %** com validação `Σ ≤ 100%`.
- **Gestão dinâmica da pie (capacidade central, não só mitigação):**
  - O admin **distribui e redistribui** % entre membros **e ele mesmo**, a partir da **reserva disponível**.
  - **Reatribuir num clique** para um membro OU para si — sobretudo quando um membro esgota a fatia.
  - Mostrar a **reserva disponível** como fatia explícita no pie chart ("Disponível").
  - Alertas ao admin a 80/95/100% da fatia de cada membro.
- **Top-up +X%:** Cloud Function incrementa `teams/{id}.tokenBudget.purchasedExtra += X% × baseBudget`; reaproveita Dodo/Momenu; **retargetado do user para a equipa**.

---

## 6. IDE (`billingStore`)

- Consumir o bloco `team` de `/v1/me` + os headers `x-team-*`.
- Mostrar "a tua fatia / o bolo" em vez de plano pessoal quando em equipa.
- No bloqueio (`tm_team_slice_exhausted`): CTA **"fala com o teu admin"** (o membro não compra; só o admin).

---

## 7. Regras de segurança (Firestore)

- Membro lê o **seu** `teams/{teamId}`; não lê equipas de outros.
- Só `ownerUid` escreve `members.*` e `percentAllocation`.
- **Só o service account (worker)** escreve `tokenBudget.tokensConsumed` e `members.*.tokensConsumed`. Clientes **nunca** escrevem consumo (senão um membro zerava-se).
- `purchasedExtra` escrito só pela Cloud Function de pagamento.

---

## 8. Decisões em aberto (menores)

1. **Plano pessoal pago + entrar em equipa:** pausar a cobrança pessoal (recomendado) vs proibir a adesão.
2. **`purchasedExtra` no reset:** persiste entre ciclos (recomendado — é capacidade comprada) vs expira.
3. **Speed (3x):** elegibilidade por tier (`team-pro`/`team-max` → como `pro`/`max`).
4. **Janela de cache para teams:** 60s (como hoje) vs mais curta para limitar overshoot × nº de membros.

> **Resolvido (movido para §1):** o admin é membro com fatia própria + **gestão dinâmica da pie** — redistribuir % da reserva disponível para qualquer membro ou para si, sobretudo no desbloqueio do hard cap.

---

## 9. Faseamento

- **Fase 0** — schema `teams/*`, `TeamDAO`, tiers em `subscription_plans`, fluxo de convite/membros. Aditivo, baixo risco.
- **Fase 1** — billing no **data-plane** (as 4 funções, dual-write) + `/v1/me` + reset/carry-over de equipa. **Shadow mode** primeiro (contabiliza + headers, não bloqueia), depois enforce.
- **Fase 2** — dashboard (pie, torres, gestão, top-up) + mitigações do cap estrito.
