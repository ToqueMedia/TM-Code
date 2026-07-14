---
name: pptx-presentation
description: Editable PowerPoint (.pptx) export via pandoc or python-pptx. Call ONLY when user explicitly asks for .pptx. Prefer slidev-presentation (dev decks) or Canva MCP (branded) otherwise.
---

# PowerPoint Export (.pptx)

Produce editable `.pptx` files when the user explicitly asks for one. Applies to "PowerPoint", ".pptx", "ficheiro Excel-de-slides", and legacy stakeholder workflows.

**Decide the path before writing code.** Most "preciso de uma apresentação" requests do not actually need .pptx — they need *a presentation*. Routing matters:

| User intent | Best path | Why |
|---|---|---|
| Dev / technical / demo / architecture | **`slidev-presentation` skill** | Markdown + Vue, editable code, version-controlled, exports to PDF/PPTX/HTML |
| Branded / marketing / sales / pitch | **Canva MCP** (run `/canva-connect`) | Templates, brand kit, magic resize, polished defaults |
| Editable .pptx for a non-technical stakeholder who will edit in PowerPoint | **This skill** (pandoc or python-pptx) | Native .pptx, opens cleanly in Office |
| Charts/tables driven by a dataset | **python-pptx** (this skill, programmatic route) | Full control, scripted from data |

Default to Slidev or Canva first. Pick this skill only when the user explicitly says ".pptx", "PowerPoint editable", or has a stakeholder constraint.

## Tooling — preference order (when this skill is the right path)

1. **Pandoc** (markdown → pptx, best for prose/bullet decks): `which pandoc`
2. **python-pptx** (programmatic, best for templated/data-driven): `python3 -c 'import pptx'`
3. **LibreOffice Impress headless** (HTML/ODP → pptx): heavyweight, skip unless already present

## Install rules

- Pandoc: `brew install pandoc` (macOS) / `choco install pandoc` (Windows admin) / `apt install pandoc` (Linux)
- python-pptx: install **inside an isolated venv**:
  ```sh
  python3 -m venv ./.venv && ./.venv/bin/pip install python-pptx
  ```
  Run build scripts via `./.venv/bin/python ./output/build_pptx.py`. Do not use `pip install --break-system-packages` — it bypasses PEP 668 protection.

Pandoc is faster for a one-shot bullet deck; python-pptx is the right call for repeatable / data-driven generation.

## Process — Pandoc route (markdown → pptx)

1. Write `./output/{name}.md`:

   ```markdown
   ---
   title: Presentation title
   author: Author
   ---

   # Section divider

   ## Slide title

   - Bullet one
   - Bullet two

   ## Two-column slide

   :::: {.columns}
   ::: {.column width="50%"}
   Left content
   :::
   ::: {.column width="50%"}
   Right content
   :::
   ::::
   ```

2. Convert: `pandoc input.md -o output.pptx --reference-doc=reference.pptx`
   - Without `--reference-doc` you get pandoc's default theme (functional, plain).
   - To customize: open `pandoc -o reference.pptx --print-default-data-file reference.pptx` output in PowerPoint, apply a theme, save. Reuse that file as the reference.

## Process — python-pptx route (programmatic)

1. Script `./output/build_pptx.py`:
   ```python
   from pptx import Presentation
   from pptx.util import Inches, Pt
   from pptx.dml.color import RGBColor
   from pptx.enum.text import PP_ALIGN

   prs = Presentation()  # or Presentation('template.pptx') for a branded template
   prs.slide_width = Inches(13.333)   # 16:9
   prs.slide_height = Inches(7.5)

   # Title slide
   slide = prs.slides.add_slide(prs.slide_layouts[0])
   slide.shapes.title.text = 'Title'
   slide.placeholders[1].text = 'Subtitle'

   # Content slide
   slide = prs.slides.add_slide(prs.slide_layouts[1])
   slide.shapes.title.text = 'Slide heading'
   body = slide.shapes.placeholders[1].text_frame
   body.text = 'First bullet'
   p = body.add_paragraph(); p.text = 'Second bullet'

   prs.save('output.pptx')
   ```
2. Run: `python3 ./output/build_pptx.py`

## Verify (both routes)

- `ls -la output.pptx` — size > 20KB (empty pptx is ~25KB)
- `unzip -l output.pptx` lists `ppt/presentation.xml`, `ppt/slides/slide1.xml`
- Reopen check: `python3 -c "from pptx import Presentation; p = Presentation('output.pptx'); print(len(p.slides))"` returns slide count

## Styling defaults (when no template)

- Aspect: **16:9** (`Inches(13.333) × Inches(7.5)`).
- Title: 36–44pt, weight 700.
- Body: 18–24pt, 1.3 line-height, max 5 bullets per slide.
- Use `prs.slide_layouts` for consistency. For brand alignment, prefer a `template.pptx` reference over hand-styling.

## Slide discipline

- One idea per slide.
- Titles are sentences, not labels ("Revenue grew 40% YoY", not "Revenue").
- Charts > tables > bullets. python-pptx supports matplotlib export → slide image.
- Section dividers between chapters.
- Title + closing summary are mandatory.

## Failure modes

- **Pandoc two-column syntax ignored**: pandoc < 2.10 lacks `:::` fenced divs. Recommend upgrading or switch to python-pptx.
- **python-pptx layouts index depends on the template**: `prs.slide_layouts[0]` is title in default template but may differ in a branded one. Print `[l.name for l in prs.slide_layouts]` to discover.
- **Images not embedded**: use `slide.shapes.add_picture('path.png', Inches(1), Inches(1), width=Inches(8))` with a real file path.
- **Output reads bland**: that is the price of editable .pptx with no brand template. Ask the user if Slidev or Canva would serve better — and re-route.

Never claim "deck generated" without the reopen check + slide count.
