// Design tokens — faithful copy of the real TM Code app (src/theme/tokens.ts).
// Every color in the video must come from here so the promo matches the product.

export const tokens = {
  colors: {
    bg: {
      app: '#0a0a0a',
      terminal: '#0a0a0a',
      panel: '#111111',
      panelAlt: '#141414',
      overlay: '#1a1a1a',
      titlebar: 'rgba(15, 15, 15, 0.95)',
      card: 'rgba(255, 255, 255, 0.05)',
      cardBorder: 'rgba(255, 255, 255, 0.08)',
      codeBlock: '#111111',
      input: 'rgba(255, 255, 255, 0.05)',
      hoverSubtle: 'rgba(255, 255, 255, 0.06)',
      userBubble: 'rgba(163, 113, 247, 0.035)',
    },

    text: {
      primary: '#e6edf3',
      secondary: '#8b949e',
      muted: '#7d8590',
      subtle: '#858585',
      disabled: '#545b64',
      inverse: '#ffffff',
      userPrompt: '#f2ecff',
      assistant: '#b9c7d9',
    },

    border: {
      default: '#262626',
      subtle: '#1a1a1a',
      glass: 'rgba(255, 255, 255, 0.08)',
      faint: 'rgba(255, 255, 255, 0.06)',
      focus: '#FE1063',
    },

    accent: {
      primary: '#FE1063',
      primaryDark: '#C10A69',
      primarySubtle: 'rgba(254, 16, 99, 0.1)',
      primaryHover: 'rgba(254, 16, 99, 0.12)',
      primaryGlow: 'rgba(254, 16, 99, 0.2)',
      purple: '#a371f7',
      purpleSubtle: 'rgba(163, 113, 247, 0.1)',
      green: '#2ea043',
      greenBright: '#56d364',
      greenSubtle: 'rgba(46, 160, 67, 0.1)',
      orange: '#fb8500',
      red: '#f85149',
      redSubtle: 'rgba(248, 81, 73, 0.1)',
      // Demo-app accent (Katondo Queue) — blue, to never compete with brand pink
      blue: '#3b8eea',
      blueBright: '#60a5fa',
      blueSubtle: 'rgba(59, 142, 234, 0.12)',
    },

    diff: {
      addedBg: 'rgba(46, 160, 67, 0.1)',
      addedText: '#7ee787',
      removedBg: 'rgba(248, 81, 73, 0.1)',
      removedText: '#ffa198',
      lineNumber: '#636870',
      hunkBg: 'rgba(163, 113, 247, 0.05)',
      hunkText: '#a371f7',
    },

    toolCall: {
      runningText: '#f0c000',
      runningBorder: 'rgba(240, 192, 0, 0.18)',
      doneText: '#2ea043',
      failedText: '#f85149',
      bodyRail: 'rgba(255, 255, 255, 0.05)',
    },

    terminal: {
      foreground: '#d4d4d4',
      green: '#0dbc79',
      cyan: '#11a8cd',
      brightGreen: '#23d18b',
      cursor: '#ffffff',
    },

    chat: {
      assistantRail: 'rgba(17, 168, 205, 0.28)',
      assistantMarker: '#11a8cd',
      userRail: '#a371f7',
    },

    windowControl: {
      close: '#ff5f57',
      minimize: '#ffbd2e',
      maximize: '#28ca42',
    },

    status: {
      running: '#28ca42',
      thinking: '#f0c000',
      error: '#ff3b30',
      idle: '#858585',
    },

    dialog: {
      backdrop: 'rgba(0, 0, 0, 0.75)',
      bg: 'rgba(15, 15, 15, 0.98)',
      border: 'rgba(254, 16, 99, 0.15)',
    },
  },

  fontFamily: {
    ui: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif',
    mono: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
  },

  gradient: {
    accentPrimary: 'linear-gradient(135deg, #FE1063 0%, #C10A69 100%)',
    logoTitle: 'linear-gradient(135deg, #FE1063 0%, #a371f7 100%)',
    heroTitle: 'linear-gradient(135deg, #e6edf3 0%, #FE1063 50%, #a371f7 100%)',
    welcomeGlow:
      'radial-gradient(ellipse at top, rgba(254, 16, 99, 0.07) 0%, transparent 50%), radial-gradient(ellipse at bottom, rgba(163, 113, 247, 0.05) 0%, transparent 50%)',
  },

  shadow: {
    window: '0 32px 90px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.03)',
    logoGlow: '0 8px 32px rgba(254, 16, 99, 0.3)',
    dialogButton: '0 8px 16px rgba(254, 16, 99, 0.2)',
    highlight: '0 0 0 4px rgba(254, 16, 99, 0.15), 0 0 24px rgba(254, 16, 99, 0.35)',
  },

  radius: {
    sm: 4,
    md: 6,
    lg: 8,
    xl: 12,
    window: 12,
    pill: 9999,
  },
} as const

export type Tokens = typeof tokens
