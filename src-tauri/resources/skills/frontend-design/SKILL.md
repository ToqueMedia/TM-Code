---
name: frontend-design
description: Polished, production-grade UIs with bold aesthetic direction — pick a distinctive visual voice, any competent stack. Call whenever you are creating or restyling a page, component, landing, or dashboard (do not wait for #design). If the project uses Chakra UI v3, defer to chakra-ui-builder.
---

# Frontend Design

Create distinctive, production-grade frontend interfaces. Reject generic AI aesthetics. The system prompt does **not** lock a UI stack or a timid visual default — this skill is the visual voice. Tailwind + local primitives is one good starting point when nothing else is specified, not a ban on shadcn, Chakra, MUI, or a custom system. Restraint is one valid direction among many, not the house style.

This skill applies whenever you are creating or restyling UI — a page, a component, a landing, a dashboard, or "make it look good". Do not wait for the developer to type `#design`. **Exception:** when the project uses Chakra UI v3 (`@chakra-ui/react@^3`), `chakra-ui-builder` is the right skill: it has the component-decision-tree, theming recipes, and v3-specific patterns this skill doesn't cover.

## Completion contract

Every interface you ship must be **functional, visually striking, cohesive in aesthetic direction, and meticulously refined in detail**. No half-styled wireframes, no Lorem Ipsum left over, no broken responsive states. The user should remember it.

## Decide the direction first

Before coding, commit to **one** bold aesthetic direction. Refined minimalism and maximalist chaos both work — what kills designs is the timid middle.

Pick from (or invent your own):
- Brutalist / raw / typography-as-architecture
- Editorial / magazine / generous whitespace
- Retro-futuristic / Y2K / chromatic aberration
- Organic / botanical / soft-curve
- Luxury / monochrome / high-contrast type
- Maximalist / collage / overlapping panels
- Industrial / utilitarian / monospace + grid
- Soft / pastel / playful / toy-like
- Art deco / geometric / metallic accents

**Vary between generations.** Two unrelated requests should not converge on the same aesthetic. Resist defaulting to "dark mode + purple gradient + Space Grotesk" — that is the new generic.

## Project-context check (do this first)

1. Read the project root for `tokens.ts`, `tailwind.config.js`, `theme.ts`, or a CSS variables file.
2. Read `package.json` to identify the UI stack: **Chakra UI**, **Tailwind + shadcn/Radix**, **Material**, **Mantine**, **plain CSS**, **vanilla HTML**.
3. Inherit the existing design system exactly — colors, fonts, spacing, components — when one exists. Do not introduce new tokens.
4. When no design system exists (greenfield component, standalone HTML deliverable, prototype), invent one and document it inline as CSS variables.

## Stack-specific defaults (when no project tokens are found)

### Chakra UI v3
- Use `Box` composition. Reject v2 patterns: no `Card/CardHeader/CardBody`, no `colorScheme`, no `isLoading`/`isOpen` booleans.
- Theme via `createSystem` + tokens; consume with `useToken` or token strings.
- Icons: `react-icons/lu` (Lucide). Use real icon names — verify before using.

### Tailwind + shadcn/Radix
- Compose via `cn()` from `@/lib/utils`. Every class must exist in Tailwind config or be defined in `globals.css`.
- Cards: `bg-card rounded-xl shadow-md border border-border p-6 transition-shadow hover:shadow-lg`.
- Buttons: primary `bg-primary text-primary-foreground rounded-lg px-4 py-2.5 font-medium hover:bg-primary/90`.
- Inputs: `border border-input rounded-lg px-3 py-2 focus:ring-2 focus:ring-ring focus:border-ring`.
- Nav: `bg-background/80 backdrop-blur-md border-b sticky top-0 z-50`.

### Plain HTML/CSS (standalone prototypes, single-file deliverables)
- One `<style>` block. CSS variables on `:root`. Phosphor Icons CDN or inline SVG.
- Mobile-first media queries. `position: sticky` over `fixed` for sandboxed previews.
- Real images via Unsplash / Picsum URLs — never `placeholder.com`, never empty `src`.

## Typography — pick characterful fonts

The default `font-family: -apple-system, system-ui, sans-serif` is forgettable. Pair a **distinctive display font** with a **refined body font**.

Strong pairings to draw from (rotate, do not converge):
- Display **Fraunces** (slab serif) + body **Inter Tight**
- Display **Instrument Serif** (italic) + body **Geist**
- Display **PP Editorial New** (or fallback **Cormorant Garamond**) + body **Söhne** (or **Inter**)
- Display **Migra** + body **Mona Sans**
- Mono only: **JetBrains Mono** or **Berkeley Mono** for utilitarian/brutalist
- Variable display: **Tobias**, **Recoleta**, **Bricolage Grotesque**, **Cabinet Grotesk**

Load via Google Fonts `<link>` in HTML, or `next/font` in Next.js. Body 16–18px, line-height 1.5–1.65. Display 48–96px, line-height 1.0–1.1, letter-spacing −0.04 to −0.02em.

## Color & theme

- One dominant color, two supporting accents. Sharp contrast wins; muddy "balanced" palettes lose.
- Use CSS variables for everything (`--color-primary`, `--color-surface`, `--radius-md`, `--shadow-lg`). Same naming in any framework.
- Dark themes: deep base (`#0a0a0a`–`#111`), reserve white for the brightest 1–2 elements. Light themes: off-white (`#fafaf7`, `#f5f3ee`) over pure white reads more designed.
- TM Code project default: `tokens.ts` — base `#0a0a0a`, brand `#FE1063` pink/magenta, gradient `#FE1063 → #C10A69`, glass `rgba(15,15,15,0.92)`. Reuse these when working inside the TM Code repo.

## Spatial composition

Asymmetry beats centered-three-card grids. Specific moves:
- Off-center hero: headline left-aligned spanning 7/12 cols, supporting visual right.
- Overlap: cards that cross the section boundary, images that escape their container.
- Diagonal flow: `transform: rotate(-2deg)` on a hero element, restored to 0 on hover.
- Density mix: a dense data table next to a spacious hero. Same density everywhere reads flat.
- Container max-width 1200–1440px, centered with `mx="auto"`. Section spacing 96–160px on desktop.

## Motion — one orchestrated moment beats ten scattered ones

- **Page load**: staggered reveal (60–90ms between siblings) with `[0.16, 1, 0.3, 1]` easing (ease-out-expo). Headline → subhead → CTA → secondary content.
- **Hover**: `y: -2` and `scale: 1.01`, 200ms duration. Subtle.
- **Scroll**: trigger reveals with `IntersectionObserver` or Framer Motion `whileInView`. One per viewport — too many feels nervous.
- **Microinteractions library** (CSS-only versions for HTML deliverables):
  - `card_hover`: `transition: transform .2s, box-shadow .2s; :hover { transform: translateY(-4px); box-shadow: var(--shadow-lg); }`
  - `button_press`: `:active { transform: scale(0.97); }`
  - `row_hover`: `:hover { background: var(--color-surface); }`
- Always honor `@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }`.

## Backgrounds & atmosphere

Solid backgrounds are fine for clinical/utilitarian aesthetics. Most designs benefit from **one** atmospheric layer:
- **Gradient mesh**: 2–3 radial gradients with low opacity, large blur, fixed position.
- **Noise texture**: 200×200 SVG noise tiled with 4–8% opacity — kills banding on dark gradients.
- **Geometric pattern**: thin grid lines, dot pattern, blueprint hatch — pair with utilitarian aesthetic.
- **Dramatic shadow**: brand-color glow `box-shadow: 0 0 80px rgba(254,16,99,0.35)` on the hero card.
- **Conic gradient**: rotating accent that suggests motion without animating.

## UI states (always include)

A polished interface handles all four:
- **Loading**: skeleton placeholders matching the final layout (not generic spinners).
- **Empty**: icon + headline + one-line explanation + primary action ("No invoices yet — create your first").
- **Error**: inline next to the field for forms; full-card with retry CTA for sections.
- **Success**: subtle confirmation (toast 2–3s, or inline checkmark), never a modal.

## Anti-aesthetics (the new generic — avoid)

These read as AI-generated default:
- Inter, Roboto, Arial, system-ui as the only typeface
- Purple-to-blue diagonal gradient on a white card
- Centered hero with three identical 1/3-width feature cards below
- `border-radius: 9999px` on every interactive element ("everything is a pill")
- Full-page glassmorphism with no atmospheric layer behind it
- Emoji-heavy headlines unless the brand is genuinely playful
- Stock illustrations from undraw.co / Storyset
- Centered text alignment as the default

Replace with characterful fonts, dominant single-color schemes, asymmetric grids, varied radii, and editorial restraint.

## Examples

<example>
<description>Pricing page — refined editorial direction</description>
<approach>Display font Fraunces 72pt italic for the headline ("Built for studios that ship."), body Inter Tight 16pt. Three pricing cards with **different heights** (middle one taller — focal). No gradient on cards; instead a single fixed background mesh of two radial gradients (`#FE1063` low-opacity + `#1a1a1a`). Buttons solid `#FE1063`, no rounded-pill — just `8px` radius. Footer micro-typography in `JetBrains Mono` for "STUDIO PRICING / V2 / 2026".</approach>
</example>

<example>
<description>Dashboard empty state — utilitarian direction</description>
<approach>Single 64×64 icon (`react-icons/lu` — `LuInbox` outline only, 1.5px stroke). Below: "No projects yet" in Inter Display 24pt, then one-line subhead in muted color, then a single primary CTA button. The card sits on a thin dotted grid background (CSS `background-image: radial-gradient(circle, var(--border) 1px, transparent 1px)` 24px tile). Total vertical rhythm 32px between elements. No illustration.</approach>
</example>

<example>
<description>Landing hero — maximalist / brutalist direction</description>
<approach>Display font set in **PP Editorial New** at 144pt, italic, breaks across 3 lines, with one word in `#FE1063` and the rest white on `#0a0a0a`. Diagonal stripe of noise texture across the upper-right. Subhead in `Berkeley Mono` 14pt, all-caps, letter-spacing 0.1em. CTA is just text with an underline + arrow — no button container. Scroll reveals add `transform: skewY(-2deg)` to the section divider.</approach>
</example>

## Process

1. **Detect stack and tokens** (read `package.json`, `tokens.ts`, `tailwind.config.js`).
2. **Pick the direction** — say it explicitly in your reasoning ("going editorial / refined") so it stays coherent.
3. **Choose the font pair** before writing any CSS. Verify Google Fonts URLs.
4. **Build mobile-first**, then layer asymmetry on desktop.
5. **Implement all four states** (loading, empty, error, success).
6. **Run `read_dev_server_logs`** for runtime errors. Visually verify in the live preview when one is open.
7. **Confirm typography is characterful** — if you defaulted to Inter, swap it before reporting done.

## Reminder

Bold direction, distinctive fonts, asymmetric layouts, atmospheric backgrounds, all four UI states. Vary aesthetics between generations. Match the project's existing system when one exists; invent a coherent one when it does not.
