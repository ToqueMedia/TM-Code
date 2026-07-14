---
name: docx-document
description: Generate Microsoft Word (.docx) files via pandoc or python-docx. Call when the user asks for Word output, meeting notes, proposals, editable docs. Multilingual triggers — invoke whenever the request mentions: "Word" / ".docx" / "documento Word" / "ata em Word" / "doc editável" (PT) / "rapport Word" / "document Word" (FR) / "informe Word" / "documento de Word" (ES) / "Word文档" / "Word 文件" (ZH).
---

# Word Document Generation (.docx)

Author Microsoft Word documents when the user asks for "Word", ".docx", "documento Word", "ata em Word", etc.

## Tooling — preference order

1. **Pandoc** (markdown → docx, best for prose): `which pandoc`
2. **python-docx** (programmatic, best for templated/tabular content): `python3 -c 'import docx'`
3. **LibreOffice headless** (existing HTML/ODT → docx conversion): `which soffice || which libreoffice`

## Install rules

- Pandoc: `brew install pandoc` (macOS) / `choco install pandoc` (Windows admin) / `apt install pandoc` (Linux)
- python-docx: install **inside an isolated venv** to avoid breaking system Python:
  ```sh
  python3 -m venv ./.venv && ./.venv/bin/pip install python-docx
  ```
  Then run scripts via `./.venv/bin/python ./output/build_docx.py`. Do not use `pip install --break-system-packages` — it bypasses PEP 668 protection and can corrupt distro Python installs.
- LibreOffice: heavyweight, avoid unless the user already has it

Prefer **python-docx** when the doc is generated once with data in hand. Prefer **pandoc** when the user will iterate on a markdown source.

## Process

1. **Check tooling**. Pick the first available from the list above.
2. **Pandoc route** (markdown prose):
   - Write `./output/{name}.md` with `#` / `##` headings, tables, lists.
   - Convert: `pandoc input.md -o output.docx --reference-doc=reference.docx` (the `--reference-doc` is optional; without it you get Pandoc's default styling).
   - For custom styling, generate a reference: `pandoc -o reference.docx --print-default-data-file reference.docx` then edit its styles in Word/LibreOffice once.
3. **python-docx route** (programmatic):
   - Script in `./output/build_docx.py`:
     ```python
     from docx import Document
     from docx.shared import Pt, Cm, RGBColor
     doc = Document()
     doc.add_heading('Title', level=0)
     p = doc.add_paragraph('Body text with ')
     p.add_run('bold').bold = True
     doc.add_table(rows=3, cols=2)  # then fill cells
     doc.save('output.docx')
     ```
   - Run: `python3 ./output/build_docx.py`
4. **Verify**:
   - `ls -la output.docx` — size > 5KB (empty docx is ~6KB)
   - `unzip -l output.docx` should list `word/document.xml`, `[Content_Types].xml`, `_rels/.rels`
   - Reopen check with python-docx: `python3 -c "from docx import Document; print(len(Document('output.docx').paragraphs))"` returns a non-zero paragraph count
5. **Report**: absolute path, size, paragraph/page count.

## Styling defaults

- Body: Calibri 11pt, 1.15 line-spacing
- Headings: Calibri Light, clear hierarchy (H1 28pt, H2 20pt, H3 16pt)
- Margins: 2.54cm (Word default) unless the user asks for compact
- Tables: header row bold, subtle shading `D9E2F3`, no vertical borders
- Use `doc.styles['Heading 1']` rather than reinventing — keeps the document editable in Word

## Failure modes

- **python-docx import fails**: create an isolated venv first (`python3 -m venv ./.venv && ./.venv/bin/pip install python-docx`) and invoke the build script via `./.venv/bin/python`. Do not use `--break-system-packages`.
- **Pandoc mangles tables**: complex tables belong to python-docx.
- **Lost formatting on reopen in Word**: python-docx writes valid OOXML but does not embed Office themes — the file opens fine but inherits Word's default template.

Never claim "Word document generated" without the `unzip -l` structure check.
