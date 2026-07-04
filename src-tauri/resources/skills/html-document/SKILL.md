---
name: html-document
description: Self-contained HTML/CSS deliverables — reports, briefs, email templates, SVG-heavy artifacts. Single file, no build, optionally converts to PDF later. Multilingual triggers — invoke whenever the request mentions: "HTML page" / "email template" / "SVG" / "infographic" / "página HTML" / "email HTML" / "relatório web" / "infográfico" (PT) / "page HTML" / "modèle e-mail" / "infographie" (FR) / "página HTML" / "plantilla de correo" / "infografía" (ES) / "HTML 页面" / "电子邮件模板" / "SVG 图形" (ZH).
---

# HTML Rich Document

Author self-contained HTML documents — reports, landing-style briefs, email templates, SVG-heavy deliverables. No build tooling required. Applies when the user asks for "página HTML", "email HTML", "SVG", "relatório web", "infográfico", or wants a visual deliverable that opens in a browser.

## Why HTML first

- Zero toolchain: opens in any browser.
- Converts downstream: pair with `pdf-document` skill to produce PDF via WeasyPrint or Puppeteer.
- Portable: single file with inline `<style>` travels anywhere.
- Easy to iterate: the user can edit in any editor without installing software.

## Process

1. **Confirm the target**: viewed in browser / converted to PDF / sent as email / embedded in a page? Target drives layout constraints (email clients strip most CSS; print needs `@page` rules; embedding needs no `<html>` wrapper).
2. **Write a single self-contained file**: one `.html` with inline `<style>`, inline SVG, base64-embedded small images when necessary. Avoid external `<link>` to fonts or styles unless the user is OK with network fetches.
3. **Structure**:
   ```html
   <!doctype html>
   <html lang="pt">
   <head>
     <meta charset="utf-8">
     <meta name="viewport" content="width=device-width, initial-scale=1">
     <title>Title</title>
     <style>
       :root { --accent: #FE1063; --bg: #0a0a0a; --text: #e6edf3; }
       * { box-sizing: border-box; margin: 0; padding: 0; }
       body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; line-height: 1.6; color: var(--text); background: var(--bg); }
       @page { size: A4; margin: 20mm; }
       @media print { body { background: white; color: #0a0a0a; } }
     </style>
   </head>
   <body>
     <!-- content -->
   </body>
   </html>
   ```
4. **Verify**:
   - `ls -la output.html` — size > 1KB
   - `head -c 100 output.html` starts with `<!doctype html>` (or `<!DOCTYPE html>`)
   - For critical deliverables, `python3 -c "from html.parser import HTMLParser; HTMLParser().feed(open('output.html').read())"` without errors confirms well-formed HTML
5. **Report**: absolute path, size, whether it is meant to be viewed / printed / emailed.

## Styling principles

- System font stack first: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif`. No Google Fonts unless the user asks (adds a network dependency).
- Use CSS variables for theme values — one change at the top, consistency everywhere.
- Respect `prefers-color-scheme` for browser viewing: `@media (prefers-color-scheme: dark) { … }`
- Print mode with `@media print`: white background, black text, hide navigation, reset shadows.
- Email mode: inline every style on the element (email clients ignore `<style>` and external CSS); use table layouts; cap width at 600px.

## SVG-heavy deliverables

- Inline SVG (`<svg>…</svg>`) travels inside the HTML — no separate asset files.
- Use `viewBox` and avoid fixed `width`/`height` on the root `<svg>` so it scales.
- `currentColor` on strokes/fills inherits from CSS — one theme change flips the SVG too.
- Accessibility: `<title>` inside `<svg>` for screen readers.

## Email-safe HTML (when the target is email)

- Table-based layout (`<table role="presentation" cellspacing="0" cellpadding="0" border="0">`).
- Inline styles on every element. No `class=` usage.
- Max width 600px; center via `<table align="center">`.
- No JavaScript. No `background-image` (Outlook ignores it). Fall back to solid colors.
- Test mental model: assume Outlook 2016/2019, which uses Word's rendering engine.

## Anti-patterns

- External stylesheets for a deliverable meant to be sent or archived.
- `<div>` grids for email.
- Web fonts loaded via `@import` for PDF conversion — WeasyPrint often times out.
- Fixed pixel widths on the body — breaks responsive display.

## Failure modes

- **Page breaks in weird places when printed**: use `page-break-inside: avoid` on cards/sections and `page-break-before: always` before chapters.
- **Fonts look different in PDF vs browser**: embed the font as base64 or accept the system-font fallback.
- **Emoji render as boxes in print**: the print engine may lack color-emoji fonts. Replace with inline SVG icons.

Never claim "HTML ready" without opening the well-formedness check.
