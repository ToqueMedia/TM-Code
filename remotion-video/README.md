# TM Code — Promo Video (Remotion)

Vídeo promocional cinematográfico do comando **/te2e** do TM Code, totalmente
recriado em React/CSS/Remotion (sem gravação de ecrã). 1920×1080 · 30fps · 42s
(1260 frames).

## Comandos

```bash
yarn install        # uma vez
yarn dev            # abre o Remotion Studio (preview interactivo)
yarn render         # renderiza out/tmcode-promo.mp4 (h264)
yarn still          # renderiza um frame para out/frame.png (--frame=N)
yarn typecheck      # tsc --noEmit
```

No Studio, além da composição principal `TMCodePromo`, cada cena está registada
individualmente na pasta `scenes` (S1-Intro … S7-Final) para iterar isoladamente.

## História (42s)

| # | Frames | Cena |
|---|---|---|
| 1 | 0–90 | Intro de marca — isologo + "The Agent-First IDE" |
| 2 | 90–210 | Janela TM Code abre; greeting ASCII; user digita o problema |
| 3 | 210–300 | Agente pensa; `Searched(stationSession)` → 7 results |
| 4 | 300–510 | Cascata de reads; diff `force-logout` com zoom e highlight |
| 4b | 510–615 | **Ecrã dedicado ao comando `/te2e`** — pill digitado + descrição real do produto |
| 5 | 615–825 | Split: `/te2e` conduz o browser — tool calls sincronizados com os cliques (modal → toast) |
| 6 | 825–1005 | Recepção 01 volta a entrar; relatório `❯ /te2e` com `✓ 4 passed` |
| 7 | 1005–1260 | Pull-back para branding + CTA "Get TM Code" |

Os textos do `/te2e` (descrição, uso, exemplos) vêm das strings reais da app
(`slashCmd.te2e.desc` e `e2e.usage` em `src/i18n/translations.ts`).

## Estrutura

- `src/tokens.ts` — paleta/fontes fiéis ao produto real (`src/theme/tokens.ts` da app)
- `src/data/` — guião único da história: timings globais (`sceneTiming`), conversa do
  agente (`agentScript`), diffs (`diffData`), app demo mockada (`mockUsers`)
- `src/components/` — UI recriada: terminal TM Code (greeting, prompt, mensagens,
  tool calls, diff estruturado, status line), chrome de janelas, app demo
  "Katondo Queue" (tabela admin, modal, toast, login) e utilitários de câmara
  (`ZoomFocus`), cursor (`AnimatedCursor`) e destaque (`HighlightBox`)
- `src/scenes/` — as 7 cenas; `src/TMCodePromo.tsx` monta a timeline
- `public/assets/` — logos reais copiados da app; `reference/` tem screenshots
  do produto usados apenas como referência visual

## Trilha sonora

Instrumental horror-funk anos 80 (inspirada no groove do Thriller, original),
gerada com a **MiniMax Music API** (`music-2.6`, `POST /v1/music_generation`):

```bash
# requer a key em MINIMAX_API_KEY ou no ficheiro .minimax_key (gitignored)
node scripts/generate-music.mjs            # grava public/assets/audio/tmcode-promo-track-raw.mp3
```

A fonte tem 2m02s; o corte aos 42s e os fades (in 0.8s / out 2.8s, alinhado com
o fade-to-black final) são feitos no próprio Remotion via `<Audio volume={...}>`
em `TMCodePromo.tsx` — frame-accurate, sem ffmpeg externo. Para regenerar com
outro estilo, edita o `PROMPT` em `scripts/generate-music.mjs` e volta a correr.

## Convenções

- Todo o motion é frame-driven (`useCurrentFrame` + `interpolate`/`spring`).
  Nunca usar animações/transições CSS — não sincronizam com o renderer.
- `interpolate` sempre com clamp nos dois lados; sem `Math.random()`/`Date.now()`.
- Cores apenas de `src/tokens.ts`. App demo usa accent azul para nunca competir
  com o rosa da marca.
- Coordenadas de cursor/highlight derivam dos exports `getAdminLayout`,
  `MODAL_LAYOUT` e `getLoginLayout` — se mudares o layout dos mocks, os alvos
  seguem automaticamente.
