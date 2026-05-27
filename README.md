<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="120" alt="TM Code" />
</p>

<h1 align="center">TM Code</h1>

<p align="center">
  <strong>The Agent-First IDE by Toque Media</strong>
</p>

<p align="center">
  Chat with AI. Watch it code. Ship faster.
</p>

<p align="center">
  <a href="https://github.com/ToqueMedia/TM-Code/releases/latest"><img src="https://img.shields.io/github/v/release/ToqueMedia/TM-Code?style=flat-square&color=FE1063" alt="Release" /></a>
  <a href="https://github.com/ToqueMedia/TM-Code/releases"><img src="https://img.shields.io/github/downloads/ToqueMedia/TM-Code/total?style=flat-square&color=a371f7" alt="Downloads" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-333?style=flat-square" alt="Platforms" />
  <img src="https://img.shields.io/badge/license-proprietary-555?style=flat-square" alt="License" />
</p>

---

### Sponsored by

<table align="center">
  <tr>
    <td align="center" width="200" height="80">
      <a href="https://platform.xiaomimimo.com/">
        <img src="https://mimo.xiaomi.com/mimo-v2-pro/assets/logo.svg" alt="Xiaomi MiMo logo" width="136">
      </a>
    </td>
  </tr>
  <tr>
    <td align="center"><a href="https://platform.xiaomimimo.com/"><strong>Xiaomi MiMo</strong></a></td>
  </tr>
</table>

---

<!-- Replace with real screenshots when available -->
<!-- ![TM Code Screenshot](docs/screenshots/chat-view.png) -->

## What is TM Code?

TM Code is a **chat-first desktop IDE** where the AI agent is the primary interface. Unlike traditional IDEs with AI sidebars, TM Code starts with a conversational interface where the agent writes code, shows diffs inline, runs terminal commands, and opens live previews — all without leaving the chat.

**The developer drives. The agent builds.**

## Key Features

- **Chat-First UX** — Start in chat, the agent writes code, you review. Switch to editor mode when needed.
- **Live Preview** — See your app running in real-time as the agent builds it.
- **Inline Diffs** — Accept or reject code changes one by one, directly in the chat.
- **Powered by MiMo** — Xiaomi's MiMo V2.5 models with native 1M-token context windows and strong agentic capabilities.
- **MCP Integration** — Connect external tools via Model Context Protocol servers.
- **Built-in Terminal** — xterm.js v6 with full PTY support.
- **Monaco Editor** — Full VS Code editing experience with split panes, breadcrumbs, and formatting.
- **Project Templates** — React, Next.js, Vue, Svelte, Angular, Express, NestJS, and more.
- **Docker Isolation** — Run projects in isolated containers with Colima support.
- **Slash Commands** — `/plan` for architecture docs, `/init` for project setup.
- **Auto-Updates** — Seamless in-app updates via GitHub Releases.

### MiMo Models

**MiMo-V2.5-Pro** — Xiaomi's strongest model yet. Native 1M-token context window, specially enhanced for general agentic capabilities, complex software engineering, and long-horizon tasks. It can autonomously complete professional tasks involving 1,000+ tool calls, work that would take human experts days.

**MiMo-V2.5** — Native omnimodal with strong agentic capabilities. Pro-level agent performance at roughly half the cost. Improved multimodal perception across image, video, audio, text understanding, native 1M-token context window, and significantly more efficient inference.

Learn more at [platform.xiaomimimo.com](https://platform.xiaomimimo.com/)

## Download

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | [Download .dmg](https://github.com/ToqueMedia/TM-Code/releases/latest) |
| Windows | [Download .exe](https://github.com/ToqueMedia/TM-Code/releases/latest) |
| Linux (Ubuntu/Debian) | [Download .deb](https://github.com/ToqueMedia/TM-Code/releases/latest) |

## Plans

| | Free | Pro | Business |
|---|---|---|---|
| **Model** | MiMo V2.5 | MiMo V2.5 Pro | MiMo V2.5 Pro |
| **Credits** | 10/day | Monthly pool | Monthly pool (4x/8x) |
| **Queue** | Max 5 concurrent | Unlimited | Unlimited |
| **Price** | $0 | Coming soon | Coming soon |

## Development

```bash
# Prerequisites: Node >= 20, Rust, Yarn

# Install dependencies
yarn install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build

# Run tests
npm test
```

## Screenshots

<!-- Add screenshots here -->
<!--
<p align="center">
  <img src="docs/screenshots/chat.png" width="800" alt="Chat View" />
  <br/><em>Chat-first interface — the agent writes code while you watch</em>
</p>

<p align="center">
  <img src="docs/screenshots/editor.png" width="800" alt="Editor View" />
  <br/><em>Full Monaco editor with split panes and inline diffs</em>
</p>

<p align="center">
  <img src="docs/screenshots/preview.png" width="800" alt="Live Preview" />
  <br/><em>Live preview alongside the chat</em>
</p>
-->

---

<p align="center">
  Built by <a href="https://toquemedia.com">Toque Media</a> · Sponsored by <a href="https://platform.xiaomimimo.com/">Xiaomi MiMo</a>
</p>
