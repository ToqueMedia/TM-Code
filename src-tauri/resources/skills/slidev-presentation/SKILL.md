---
name: slidev-presentation
description: Developer-grade presentations as markdown + Vue (Slidev). Primary path for architecture/demo/conference decks. Exports to PDF/PPTX/HTML. Offline, free, themable.
---

# Slidev Presentation (dev-first decks)

Author developer-grade presentations as Markdown + Vue. Primary path for technical decks (architecture reviews, demos, conference talks, internal walkthroughs). Free, offline, version-controllable.

## When this beats the alternatives

| You want… | Use this skill | Use elsewhere |
|---|---|---|
| Architecture / demo / code-heavy deck | **Slidev** | — |
| Marketing / branded / sales deck | — | Canva MCP (`/canva-connect`) |
| Quick md → pptx conversion (no polish) | — | Pandoc (`pptx-presentation` skill) |
| Charts from a dataset | — | python-pptx (`pptx-presentation` skill) |

Slidev wins when: dev audience, code samples on slides, version control matters, offline export needed, themable look-and-feel.

## Tooling

Node ≥ 18 is a TM Code requirement → `slidev` runs immediately via `npx`. No global install needed.

- **Live preview**: `npx -y @slidev/cli@latest <slides.md> --open`
- **Static build (HTML)**: `npx -y @slidev/cli@latest build <slides.md>`
- **PDF export**: `npx -y @slidev/cli@latest export <slides.md>` — produces `slides-export.pdf`
- **PPTX export**: `npx -y @slidev/cli@latest export <slides.md> --format pptx`
- **PNG per slide**: `npx -y @slidev/cli@latest export <slides.md> --format png`

Playwright is required for export — install once with `npx playwright install chromium`. The skill should run this when the user confirms.

## Process

1. **Decide direction**: pick a Slidev theme that matches intent.
   - `default` — clean, neutral
   - `seriph` — editorial / serif headlines
   - `apple-basic` — refined / Apple-keynote feel
   - `bricks` — colourful / playful
   - `purplin` — technical / dark
   - `the-unnamed` — minimal monochrome
   - Custom themes via `npm pkg` — only when the user has one.
2. **Scaffold the markdown** in `./output/slides.md`:

   ```markdown
   ---
   theme: seriph
   title: Architecture Review — Q2 2026
   info: |
     ## Q2 2026 Review
     Internal walkthrough of the new ingestion pipeline.
   class: text-center
   highlighter: shiki
   transition: slide-left
   mdc: true
   fonts:
     sans: 'Inter Tight'
     serif: 'Fraunces'
     mono: 'JetBrains Mono'
   ---

   # Architecture Review
   ### Q2 2026 — Ingestion pipeline rewrite

   <div class="text-sm opacity-60 mt-8">presented by ${name}</div>

   ---
   layout: two-cols
   ---

   # Why we rebuilt it

   - Latency p99 above SLA
   - Hot-partition contention
   - Vendor lock-in on Kinesis

   ::right::

   ```mermaid
   graph LR
     A[Producer] --> B[Bus]
     B --> C[Worker pool]
     C --> D[(Storage)]
   ```

   ---

   # Throughput before / after

   ```ts {monaco}
   const before = { p50: 80, p99: 1200 }
   const after  = { p50: 42, p99: 180 }
   ```

   <Tweet id="..." />
   ```

3. **Run live preview** for the user (when a TM Code dev server slot is free) or just build static.
4. **Export** to the format(s) the user asked for.
5. **Verify**:
   - PDF: `file slides-export.pdf` starts with `PDF document`, size > 50KB
   - PPTX: `unzip -l slides-export.pptx` lists `ppt/presentation.xml` + at least one slide
   - HTML build: `ls dist/` shows `index.html` and `assets/`
6. **Report**: absolute path, slide count (count `^---$` separators in source), export format(s).

## Slidev features worth using

- **Code with line highlights**: ` ```ts {1|3-5|all} ` reveals lines progressively
- **Monaco editor inline**: `{monaco}` after the lang makes the code block editable in the live deck (great for live-coding demos)
- **MDC syntax**: `::title{.text-red}` adds classes inline
- **Layouts**: `two-cols`, `image-right`, `center`, `quote`, `statement`, `intro`, `section`, `cover`, `end`
- **Components in slides**: `<Tweet id="..." />`, `<Youtube id="..." />`, `<Toc />`, `<Counter :count="3" />`
- **Diagrams**: built-in Mermaid + PlantUML support
- **Click animations**: `<v-click>` / `<v-clicks>` for stepwise reveals
- **Speaker notes**: HTML comment after `---` divider (`<!-- speaker note -->`)
- **Dark mode toggle**: `<Toggle />` component, theme-aware

## Theming (when the user has a brand)

Reuse the project's design tokens:

```yaml
---
theme: default
fonts:
  sans: 'Inter Tight'
  serif: 'Fraunces'
  mono: 'JetBrains Mono'
themeConfig:
  primary: '#FE1063'
  accent: '#a371f7'
---
```

Or write a custom `style.css` co-located with the slides — Slidev autoloads it.

## Failure modes

- **Playwright missing**: export fails with a clear message. Install with `npx playwright install chromium` (≈300MB, confirm with user).
- **PPTX export quality**: Slidev's PPTX is rendered slide-as-image (Playwright screenshot), which means perfect visual fidelity but text is not editable in PowerPoint. For editable PPTX, use the `pptx-presentation` skill (pandoc/python-pptx).
- **Mermaid render fails on export**: usually a syntax error — check `npx -y @slidev/cli build` output for the offending diagram.
- **Custom fonts not loading**: ensure they are in `fonts:` frontmatter so Slidev injects the Google Fonts `<link>`.

## Anti-patterns

- Inline base64 images in markdown — use `<img src="./assets/foo.png">` co-located.
- Five bullets per slide. One idea per slide; bullets ≤ 3.
- Auto-generated "Thank You" final slide — write a memorable closing instead (call-to-action, repo link, contact).

Never claim "deck generated" without the file-format check appropriate to the chosen export.
