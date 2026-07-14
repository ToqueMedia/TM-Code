---
name: xlsx-spreadsheet
description: Generate Microsoft Excel (.xlsx) workbooks via openpyxl or pandas. Call when the user asks for Excel, spreadsheets, tabular reports, data exports. Multilingual triggers — invoke whenever the request mentions: "Excel" / ".xlsx" / "spreadsheet" / "folha de cálculo" / "tabela em Excel" / "relatório em Excel" / "exportação de dados" (PT) / "feuille de calcul" / "tableur" (FR) / "hoja de cálculo" / "informe Excel" (ES) / "Excel表格" / "电子表格" (ZH).
---

# Excel Spreadsheet Generation (.xlsx)

Author Microsoft Excel workbooks when the user asks for "Excel", ".xlsx", "folha de cálculo", "spreadsheet", "relatório em Excel".

## Tooling — preference order

1. **openpyxl** (Python, best for programmatic data + formatting): `python3 -c 'import openpyxl'`
2. **pandas + openpyxl** (when the data is already tabular): `python3 -c 'import pandas'`
3. **xlsx-js-style** (Node, when project is JS-first): `npx xlsx --version` after install

There is no reliable pandoc path to .xlsx — skip it for spreadsheets.

## Install rules

Use an isolated venv to keep system Python clean:
```sh
python3 -m venv ./.venv && ./.venv/bin/pip install openpyxl
```
Run build scripts via `./.venv/bin/python ./output/build_xlsx.py`. Add `pandas` to the same `pip install` call when you also need DataFrame ergonomics (~30MB download — confirm with user). Do not use `pip install --break-system-packages`; it bypasses PEP 668 protection and can corrupt distro Python.

For JS-first projects: `npm install --save-dev xlsx-js-style` inside the project directory.

Default to **openpyxl** — small, focused, handles formatting properly.

## Process

1. **Check tooling**. If `import openpyxl` fails, ask the user to confirm pip install.
2. **Write the build script** in `./output/build_xlsx.py`:
   ```python
   from openpyxl import Workbook
   from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
   from openpyxl.utils import get_column_letter

   wb = Workbook()
   ws = wb.active
   ws.title = 'Sheet name'

   # Headers
   headers = ['Col A', 'Col B', 'Col C']
   for col_idx, value in enumerate(headers, start=1):
       cell = ws.cell(row=1, column=col_idx, value=value)
       cell.font = Font(bold=True, color='FFFFFF')
       cell.fill = PatternFill('solid', fgColor='2F5597')
       cell.alignment = Alignment(horizontal='center', vertical='center')

   # Data rows
   for row_idx, row_data in enumerate(data, start=2):
       for col_idx, value in enumerate(row_data, start=1):
           ws.cell(row=row_idx, column=col_idx, value=value)

   # Auto-width columns
   for col_idx in range(1, len(headers) + 1):
       ws.column_dimensions[get_column_letter(col_idx)].width = 18

   # Freeze header
   ws.freeze_panes = 'A2'

   wb.save('output.xlsx')
   ```
3. **Run**: `python3 ./output/build_xlsx.py`
4. **Verify**:
   - `ls -la output.xlsx` — size > 5KB
   - `unzip -l output.xlsx` lists `xl/workbook.xml`, `xl/sharedStrings.xml`, `[Content_Types].xml`
   - Reopen check: `python3 -c "from openpyxl import load_workbook; wb = load_workbook('output.xlsx'); print(wb.sheetnames, wb.active.max_row)"`
5. **Report**: path, size, sheet names, row count per sheet.

## Styling defaults

- Header row: bold white on brand color (`2F5597` blue default, or the user's brand), 16pt row height
- Data rows: 11pt Calibri, left-aligned text, right-aligned numbers
- Number formats: `'#,##0.00'` for decimals, `'#,##0'` for integers, `'0.00%'` for percentages, `'yyyy-mm-dd'` for dates
- Freeze the header row (`ws.freeze_panes = 'A2'`)
- Column widths: set explicitly — auto-width requires iterating the data

## Advanced patterns

- **Formulas**: `ws.cell(row=N, column=M, value='=SUM(B2:B10)')` — openpyxl writes them, Excel evaluates on open.
- **Charts**: use `openpyxl.chart.BarChart`, `LineChart`, `PieChart`. Keep charts minimal — they bloat the file.
- **Conditional formatting**: `openpyxl.formatting.rule.ColorScaleRule` for heatmaps, `CellIsRule` for thresholds.
- **Multiple sheets**: `wb.create_sheet('Sheet 2')`. Keep related data in one workbook, not many files.

## Failure modes

- **pip install fails with "externally-managed-environment"** (Debian/Ubuntu Python 3.12+): use the venv approach in "Install rules" above. Avoid `--break-system-packages` even though pip suggests it — it pollutes the distro Python and can break apt-managed packages later.
- **Excel refuses to open file**: almost always malformed XML from manual string building — use openpyxl's API, never hand-write the XML.
- **Large datasets (>100K rows)**: openpyxl is memory-heavy. Use `Workbook(write_only=True)` for streaming.

Never claim "spreadsheet generated" without the reopen check.
