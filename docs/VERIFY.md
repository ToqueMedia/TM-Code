# Pending Verifications

Tudo o que compila, passa testes e está implementado mas **ainda não foi observado em runtime real**. Cada item tem: o que verificar, como, e onde está o risco.

Atualizado: 2026-04-20

---

## 1. Backend proxy — routing do GLM-5.1

**Risco:** alto. Se falhar, o toggle de thinking na UI é silent no-op mesmo com o parâmetro a ser enviado pelo frontend.

**Contexto:** `modelProfiles.ts` define `GLM_5_1.thinkingParam: 'reasoning'`. O `buildThinkingParam()` constrói `{ reasoning: { enabled: true|false } }` — formato **OpenRouter**.

**O que verificar no código do backend proxy:**

1. Para o modelId `Z-AI/GLM-5.1`, para que provider encaminha? OpenRouter? Z-AI API nativa? Outro?
2. Se for OpenRouter → formato `{ reasoning: { enabled } }` é aceite. OK.
3. Se for **Z-AI direto** → o formato correto é `{ thinking: { type: "enabled" | "disabled" } }` OU `{ enable_thinking: true|false }`. O nosso `reasoning` seria ignorado.
4. Verificar também se o proxy loga o body final enviado ao provider — útil para debug.

**Se o routing for Z-AI direto:**
- Mudar `thinkingParam` no perfil para `'thinking'` ou `'enable_thinking'`
- Re-testar com toggle ON e OFF, verificar `reasoning_content` no response stream

**Teste sugerido:**
```
1. Plano pago, toggle thinking ON
2. Pedir algo trivial ("soma 1+1")
3. Observar se há bloco de reasoning no response (visível via ReasoningBlock no chat)
4. Toggle OFF, repetir
5. Segundo caso NÃO deve mostrar reasoning
```

Se ambos mostram (ou não mostram) reasoning identicamente, o toggle está broken ponta-a-ponta.

---

## 2. Backend proxy — DeepSeek strips thinking params

**Risco:** baixo. Já tem comentário no código a confirmar, e o `supportsThinking: false` impede o frontend de enviar o param.

**Contexto:** `modelProfiles.ts:130-132` afirma que `proxy.ts MODELS_NO_THINKING` faz o strip.

**O que verificar:**
1. `proxy.ts` tem efetivamente uma lista `MODELS_NO_THINKING`?
2. DeepSeek V3.2 está incluído?
3. O strip acontece ANTES ou DEPOIS da chamada ao provider?

Se a lista não existir ou não incluir DeepSeek, o parâmetro (que o frontend não envia, mas poderia ser injetado noutro lado) pode chegar ao provider e causar 400.

---

## 3. Preview do APPIA — render real no Windows

**Risco:** alto. Foi a origem de toda a cadeia de fixes. Não foi observado a funcionar.

**Fixes aplicados que dependem desta verificação:**
- `probe_server` com redirect following
- `isFullstackWrapper` recursivo via `package.json`
- `classifyProbedUrl` port-authoritative em fullstack
- `--host 0.0.0.0` injetado
- `127.0.0.1` forçado no Windows (vs `localhost` no macOS)
- Proxy `tmpreview://` bypassado em Windows (carrega URL HTTP diretamente)
- Multi-URL detection paralela
- `backendUrlMirrored` para monolithic fullstack

**Teste:**
1. Abrir APPIA no TM Code Windows
2. Pedir ao agente: "Corre a aplicação"
3. **Esperado:**
   - Agente deteta `.toquemedia-id` NÃO presente (é externo) → adapta
   - Inspeciona package.json, vê `dev:server` + `dev:client` já com portas 7777/7773
   - Chama `start_dev_server` com defaults (porque as portas batem certo)
   - Vite bind em 7773, Express em 7777
   - Preview abre com UI da React app, **não fica preto**
   - Botão drawer ⚡ (fullstack) aparece; clique abre HTTP Client em 7777

**Falha modes a observar:**
- Preview preto → revisitar `proxy_target` em `lib.rs` ou o direct-URL routing
- Preview mostra 7777 em vez de 7773 → `classifyProbedUrl` falhou, verificar o stream de logs
- Nenhum URL detetado → regex `URL_REGEX_GLOBAL` ou a ordem de arranque falhou

---

## 4. Menu dropdowns (Windows)

**Risco:** médio. Três fixes sequenciais; o último ainda não observado.

**Fixes:**
- `MinimalTitleBar.handleMouseDown` respeita `data-tauri-drag-region="false"` via `closest()`
- `MenuBar` faz `pushOverlay`/`popOverlay` (move webview off-screen quando dropdown aberto)
- `ContextMenuOverlay` via `createPortal(document.body)` (escapa stacking contexts)
- Hints traduzidos para `Ctrl+X` style (não mais `⌘X`)

**Teste:**
1. Windows, com preview fullstack aberta
2. Clicar File → dropdown abre ✓
3. Dropdown fica visível, **acima de tudo** incluindo preview ✓
4. Clicar um item do dropdown (ex: "Open Folder") — ação executa ✓
5. Clicar fora — dropdown fecha, preview volta à posição ✓
6. Hint "Ctrl+O" visível à direita de "Open Folder" ✓

**Falha modes:**
- Dropdown não abre → `startDragging` ainda está a engolir o clique; verificar ancestrais do target
- Dropdown abre mas outros elementos por cima → createPortal não está a aplicar; verificar import `react-dom`
- Dropdown abre, preview ainda visível atrás → `pushOverlay` não disparou; verificar `useEffect` em `MenuBar`

---

## 5. Port override path (start_dev_server)

**Risco:** médio. Código novo, exercitado só em testes unit, nunca em runtime.

**O que precisa acontecer:**
1. Projeto externo (sem `.toquemedia-id`), com backend em porta não-convencional (ex: 8080)
2. Agente inspeciona e chama:
   ```
   start_dev_server({
     command: "npm run dev",
     project_kind: "backend",
     backend_port: 8080
   })
   ```
3. `devServerManager.start` recebe `backendPort: 8080`
4. `kill_port(8080)` é chamado (não 7777)
5. `classifyProbedUrl` usa 8080 como backend_port no port-authoritative check
6. HTTP Client drawer abre com base URL `http://127.0.0.1:8080`

**Teste sugerido:**
- Criar projeto Express com `app.listen(8080)`
- Abrir no TM Code
- Pedir "corre a API"
- Verificar se o agente passa `backend_port: 8080` (observar no chat)
- Verificar se o painel HTTP Client aponta para 8080

---

## 6. `tm_code_owned` decision tree no prompt

**Risco:** baixo-médio. O ficheiro `.toquemedia-id` é detetado; a ramificação no prompt agora está em Reminder (U-Curve recency).

**O que verificar:**
1. Abrir um projeto TM Code (criado via template) — confirma que `.toquemedia-id` existe no root
2. Environment do prompt mostra `tm_code_owned: true (TM Code authored — use canonical structure; ports 7773/7777)`
3. Abrir um projeto externo — Environment mostra `tm_code_owned: false (external project — adapt to it; ...)`
4. Agente comporta-se de acordo — não reescreve scripts em projeto externo

**Como inspecionar o prompt real:**
Não há ferramenta UI exposta. Alternativas:
- Adicionar log temporário em `contextBuilder.buildSystemPrompt` que dumpa o prompt para a consola
- Ou adicionar um comando `/debug-prompt` em CMD mode

---

## 7a. FALHA OBSERVADA — auto-migration não disparou no APPIA

**Data:** 2026-04-20
**Cenário:** APPIA tem `.toquemedia-id` (TM Code project). `client/package.json` tem `"dev": "npx vite --port 7773"` sem `--host 0.0.0.0`. O agente correu `start_dev_server` sem primeiro corrigir o script. Vite bindou IPv6-only. Preview ficou preto.

**O que devia ter acontecido segundo a system prompt (Reminder #5):**
- Agente lê `tm_code_owned: true` em Environment
- Inspeciona `package.json` antes de chamar `start_dev_server`
- Deteta que `client/package.json` frontend script não é canónico (`vite --port 7773 --host 0.0.0.0`)
- Corrige, commit separado, depois chama `start_dev_server`

**Hipóteses do porquê falhou:**
1. A regra da canonical structure está em Reminder mas diz "inspect package.json" implicitamente — pode precisar de instrução EXPLÍCITA como "before calling start_dev_server on a TM Code project, first read root + sub-package.json files and verify canonical compliance".
2. O agente pode ter visto o root `package.json` (que tem concurrently — canónico) e parado aí, sem descer para `client/package.json`.
3. Workload-inertia: o agente pode ter priorizado "correr rapidamente" em vez de "verificar compliance".

**Mitigação estrutural aplicada:** `PREFERRED_HOST = 'localhost'` no devServerManager + URL original (não 127.0.0.1) no lib.rs path direto. Vite IPv6-only agora funciona porque WebView2 faz Happy Eyeballs. Preview renderiza sem depender de `--host 0.0.0.0` estar presente.

**Ação futura:** reforçar a system prompt com "inspect all sub-package.json files recursively", OU criar um tool dedicado `verify_project_compliance` que o agente DEVE chamar antes do primeiro `start_dev_server` em cada projeto.

## 7. Auto-migration em projeto TM Code com drift

**Risco:** médio. Comportamento descrito na system prompt mas nunca observado.

**Setup:** pegar num projeto que tenha `.toquemedia-id` mas foi editado para usar `npm run dev --workspaces` em vez de `concurrently`.

**Teste:**
1. Editar manualmente um projeto TM Code para usar `"dev": "npm run dev --workspaces"`
2. Abrir no TM Code, pedir "corre a app"
3. **Esperado:**
   - Agente deteta `tm_code_owned: true`
   - Lê package.json, vê o script drift
   - Instala `concurrently` via execute_command
   - Reescreve `"dev"` para a forma canónica
   - Commit separado da migração
   - Depois chama `start_dev_server` e preview arranca normalmente

**Falha modes:**
- Agente não deteta drift → prompt não está a ser lido corretamente ou a regra ficou fraca demais
- Agente deteta mas não migra antes de correr → primeiro start falha, segundo funciona (não é fatal mas é UX má)
- Agente confunde TM Code project com external e adapta em vez de migrar → o marker `.toquemedia-id` não está a chegar ao prompt

---

## 8. Language switch — conversation resumption

**Risco:** médio. Os fixes atacam três camadas (cache, invalidation, prompt emphatic phrasing) mas o **in-context learning é força probabilística**, não um switch binário.

**Teste:**
1. Iniciar conversa em English
2. Deixar o agente responder 3-4 vezes em English
3. Mudar `agentLanguage` para `pt` em Settings
4. Enviar nova mensagem
5. **Esperado:** resposta imediata em Português, mesmo com history em English
6. Se resposta voltar em English (ou metade-misturada): emphatic phrasing não foi suficiente — considerar injetar uma mensagem de sistema/system-reminder no stream como reforço

**Plano B se falhar:**
- Injetar um `[LANGUAGE_OVERRIDE]` system-reminder pseudo-tool-result na conversation history antes de chamar o agente, forçando reset imediato

---

## 9. Rust changes não-testados

**Tudo compila (`cargo check`), mas alguns code paths foram introduzidos nesta sequência e nunca exercitados:**

- `windows_pids_on_port` — parser de `netstat -aon` linha a linha (Windows only)
- `probe_server` — reqwest client com redirect `limited(3)` e Content-Type extraction
- `skip_port_env` parameter em `start_dev_server` (agora snake_case)
- Wrapper detection Rust-side (fallback quando TS-side falha)
- `dev-server-output` batching (100ms / 50 linhas)

Qualquer regressão nestes path pode ser apanhada pela sequência de testes dos pontos #3-#7.

---

## 10. Observabilidade — o que falta

Sugestão de futuro para reduzir ciclos de "implementei mas não sei se funciona":

1. **Dev-only prompt dump**: comando `/debug-prompt` que mostra o system prompt atual
2. **Dev-only request/response logger**: em `agentService.ts`, log do body enviado e do stream recebido
3. **Métricas simples** do devServerManager: contador de URLs detetadas, classificadas, timeouts

Isto tornaria #1, #6, #8 automaticamente verificáveis sem ginástica manual.

---

## Prioridade sugerida (descrescente)

1. **Preview do APPIA render (#3)** — o resto depende disto para saber se os fixes de Windows funcionam
2. **Menu dropdowns visíveis (#4)** — UX imediata, fácil de testar
3. **Backend proxy GLM-5.1 (#1)** — pede só inspecção do código do proxy
4. **Language switch (#8)** — testável em 30s de conversa
5. **tm_code_owned decision tree (#6)** — testável só inspecionando comportamento do agente
6. **Port override (#5)** — só fica relevante para projetos externos com portas não-convencionais
7. **Auto-migration (#7)** — precisa setup artificial
8. **Backend proxy DeepSeek (#2)** — confirmação de algo que já tem comentário
