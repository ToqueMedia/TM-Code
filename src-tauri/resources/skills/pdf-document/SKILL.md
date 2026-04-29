---
name: pdf-document
description: Generate PDF files (reports, invoices, briefs, articles) via pandoc, WeasyPrint, Puppeteer or ReportLab. Call when the user asks for PDF output.
---

# PDF Document Generation

Create PDF files (reports, invoices, briefs, articles). CMD-mode skill — applies when the user asks for "PDF", "gera em PDF", "exporta para PDF", or similar.

## Tooling — preference order

Python 3 is guaranteed on TM Code. Pandoc and Node are common but not guaranteed. Check before you commit to a path.

1. **Pandoc + LaTeX** (best typography): `which pandoc && which pdflatex`
2. **WeasyPrint** (pure Python, HTML/CSS → PDF): `python3 -c 'import weasyprint'`
3. **Puppeteer** (Node, HTML → PDF via headless Chrome): `npx -v`
4. **ReportLab** (Python, programmatic layout): `python3 -c 'import reportlab'`
5. **Markdown-only fallback**: write a polished `.md` and tell the user `pandoc in out.pdf` converts it when installed.

## Install rules

Install only after the user confirms (PDF generation is often one-off and system-wide installs shouldn't be silent):

- Pandoc: `brew install pandoc basictex` (macOS), `choco install pandoc miktex` (Windows admin), `apt install pandoc texlive` (Linux)
- WeasyPrint / ReportLab: install **inside an isolated venv** to keep system Python untouched:
  ```sh
  python3 -m venv ./.venv && ./.venv/bin/pip install weasyprint   # or reportlab
  ```
  Then call via `./.venv/bin/python -m weasyprint input.html output.pdf`. WeasyPrint also needs system libs (`pango`, `cairo`) on Linux — installable via `apt install libpango-1.0-0 libcairo2`. Do not use `pip install --break-system-packages`; it bypasses PEP 668 and can corrupt distro Python.

Prefer ReportLab or WeasyPrint when the user does not want a brew/apt install.

## Process

1. **Check tooling**. Run the `which` / `python3 -c 'import …'` calls for the candidates above and pick the first available.
2. **Choose the route**:
   - Content-first (articles, reports, briefs with markdown semantics) → **pandoc** if available.
   - Layout-heavy (invoices, forms, certificates with positioned elements) → **reportlab** or **weasyprint** with handcrafted HTML/CSS.
   - When only markdown fallback is possible → write `.md`, explain to the user which tool to install to convert.
3. **Draft content as Markdown or HTML** into `./output/{name}.md` or `./output/{name}.html` so the user can edit and re-run. Do not dump CSS inline into a single monolithic file if re-generation is likely.
4. **Generate**:
   - Pandoc: `pandoc input.md -o output.pdf --pdf-engine=pdflatex -V geometry:margin=1in`
   - WeasyPrint: `python3 -m weasyprint input.html output.pdf`
   - Puppeteer: one-file Node script using `puppeteer.launch({ headless: 'new' }); page.pdf({ format: 'A4', printBackground: true })`
5. **Verify**:
   - `ls -la output.pdf` — size > 1KB
   - `file output.pdf` must start with `PDF document`
   - For critical deliverables, `pdfinfo output.pdf` confirms page count matches expectation
6. **Report**: absolute path of the generated file, size, page count (when known).

## Styling defaults (pandoc / weasyprint)

- Page: A4, 25mm margins (1in).
- Body: 11pt, line-height 1.5, serif for prose, sans-serif for tables/data.
- Headings: weight 700, clear hierarchy (H1 24pt → H4 13pt).
- Code blocks: monospace 10pt, background `#f5f5f5`, 1px border.
- Tables: simple horizontal rules (no vertical borders), alternating row shading optional.
- Respect user's language: Portuguese content → pass `-V lang=pt` to pandoc; WeasyPrint honors `lang=""` in HTML.

## Failure modes

- **LaTeX engine missing** (`pdflatex: command not found`) with pandoc: fall back to `--pdf-engine=weasyprint` when WeasyPrint is available, or suggest `brew install basictex`.
- **Unicode / CJK / emoji**: for pandoc + pdflatex use XeLaTeX (`--pdf-engine=xelatex -V mainfont="Helvetica"`) or switch to WeasyPrint.
- **Empty output**: check stderr from pandoc/weasyprint — usually missing LaTeX package or invalid CSS.

Never claim success without the `file` command confirming it is a real PDF.
