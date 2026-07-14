// src/theme/tokens.ts — Single source of truth for all design values

export const tokens = {
  colors: {
    // === Backgrounds (Deep Dark — #0a0a0a base) ===
    bg: {
      app: '#0a0a0a',
      welcome: '#0a0a0a',
      sidebar: '#0f0f0f',
      overlay: '#1a1a1a',
      titlebar: 'rgba(15, 15, 15, 0.95)',
      activitybar: '#111111',
      statusbar: '#0d0d0d',
      terminal: '#0a0a0a',
      input: 'rgba(255, 255, 255, 0.05)',
      hover: 'rgba(254, 16, 99, 0.15)',
      hoverSubtle: 'rgba(255, 255, 255, 0.06)',
      selection: 'rgba(254, 16, 99, 0.2)',
      activeItem: 'rgba(254, 16, 99, 0.12)',
      glass: 'rgba(15, 15, 15, 0.92)',
      card: 'rgba(255, 255, 255, 0.05)',
      cardBorder: 'rgba(255, 255, 255, 0.08)',
      codeBlock: '#111111',
      codeInline: 'rgba(255, 255, 255, 0.06)',
      codeBlockHeader: '#1a1a1a',
      dark: '#0a0a0a',
      mainLayout: '#0a0a0a',
      sidebarBackdrop: 'rgba(0, 0, 0, 0.5)',
      sidebarGlass: 'rgba(10, 10, 10, 0.95)',
      tabHover: '#1a1a1a',
      footerOverlay: 'rgba(255, 255, 255, 0.02)',
      whiteMicro: 'rgba(255, 255, 255, 0.01)',
      whiteHover: 'rgba(255, 255, 255, 0.04)',
      whiteOverlay: 'rgba(255, 255, 255, 0.1)',
      whiteSubtle: 'rgba(255, 255, 255, 0.06)',
      blackOverlay: 'rgba(0, 0, 0, 0.5)',
      blackOverlayStrong: 'rgba(0, 0, 0, 0.6)',
      panel: '#111111',
      panelAlt: '#141414',
    },

    // === Text ===
    text: {
      primary: '#e6edf3',
      secondary: '#8b949e',
      muted: '#7d8590',
      subtle: '#858585',
      dimmed: '#969696',
      disabled: '#545b64',
      inverse: '#ffffff',
      code: '#e6edf3',
      link: '#FE1063',
      statusbar: '#e2e8f0',
      hint: '#64748b',
      placeholder: '#94a3b8',
    },

    // === Borders ===
    border: {
      default: '#262626',
      subtle: '#1a1a1a',
      input: 'rgba(255, 255, 255, 0.1)',
      inputAlt: 'rgba(255, 255, 255, 0.12)',
      glass: 'rgba(255, 255, 255, 0.08)',
      focus: '#FE1063',
      statusbar: '#1a1a1a',
      activitybar: '#1a1a1a',
      sidebar: 'rgba(255, 255, 255, 0.06)',
      sidebarPanel: 'rgba(255, 255, 255, 0.06)',
      panel: 'rgba(255, 255, 255, 0.08)',
      tab: '#1a1a1a',
      footer: '#262626',
    },

    // === Accent / Brand ===
    accent: {
      primary: '#FE1063',
      primaryDark: '#C10A69',
      primarySubtle: 'rgba(254, 16, 99, 0.1)',
      primaryMuted: 'rgba(254, 16, 99, 0.3)',
      primaryHover: 'rgba(254, 16, 99, 0.12)',
      primaryGlow: 'rgba(254, 16, 99, 0.2)',
      primaryBorder: 'rgba(254, 16, 99, 0.6)',
      primaryFocus: 'rgba(254, 16, 99, 0.5)',
      blue: '#007acc',
      blueAlt: '#0078d4',
      blueBright: '#60a5fa',
      purple: '#a371f7',
      purpleDark: '#8250df',
      purpleSubtle: 'rgba(163, 113, 247, 0.1)',
      purpleMuted: 'rgba(163, 113, 247, 0.3)',
      purpleHover: 'rgba(163, 113, 247, 0.12)',
      green: '#2ea043',
      greenHover: '#27903c',
      greenBright: '#56d364',
      greenSubtle: 'rgba(46, 160, 67, 0.1)',
      greenMuted: 'rgba(46, 160, 67, 0.3)',
      orange: '#f77f00',
      orangeBright: '#fb8500',
      red: '#f85149',
      redSubtle: 'rgba(248, 81, 73, 0.1)',
      redMuted: 'rgba(248, 81, 73, 0.3)',
    },

    // === Chat ===
    chat: {
      userBubble: 'rgba(254, 16, 99, 0.08)',
      assistantBubble: 'rgba(255, 255, 255, 0.05)',
    },

    // === Diff rendering ===
    diff: {
      addedBg: 'rgba(46, 160, 67, 0.1)',
      addedText: '#7ee787',
      removedBg: 'rgba(248, 81, 73, 0.1)',
      removedText: '#ffa198',
      lineNumber: '#636870',
    },

    // === Tool call states ===
    toolCall: {
      runningBg: 'rgba(240, 192, 0, 0.06)',
      runningBorder: 'rgba(240, 192, 0, 0.2)',
      runningText: '#f0c000',
      failedBg: 'rgba(248, 81, 73, 0.06)',
      failedBorder: 'rgba(248, 81, 73, 0.2)',
      successBg: 'rgba(46, 160, 67, 0.06)',
      successBorder: 'rgba(46, 160, 67, 0.2)',
    },

    // === Window controls (macOS-style) ===
    windowControl: {
      close: '#ff5f57',
      closeHover: '#ff4136',
      closeShadow: 'rgba(255, 95, 87, 0.4)',
      closeHoverShadow: 'rgba(255, 95, 87, 0.6)',
      minimize: '#ffbd2e',
      minimizeHover: '#ff9500',
      minimizeShadow: 'rgba(255, 189, 46, 0.4)',
      minimizeHoverShadow: 'rgba(255, 189, 46, 0.6)',
      maximize: '#28ca42',
      maximizeHover: '#00d600',
      maximizeShadow: 'rgba(40, 202, 66, 0.4)',
      maximizeHoverShadow: 'rgba(40, 202, 66, 0.6)',
    },

    // === Navigation icons ===
    nav: {
      icon: '#8e8e93',
      iconHover: '#ffffff',
      shimmer: 'rgba(255,255,255,0.1)',
    },

    // === Status indicators ===
    status: {
      running: '#28ca42',
      warning: '#ff9500',
      error: '#ff3b30',
      info: '#FE1063',
      idle: '#858585',
    },

    // === Scrollbar ===
    scrollbar: {
      thumb: 'rgba(255, 255, 255, 0.12)',
      thumbHover: 'rgba(255, 255, 255, 0.2)',
      track: 'transparent',
      explorerThumb: 'rgba(255, 255, 255, 0.1)',
      explorerThumbHover: 'rgba(255, 255, 255, 0.18)',
      explorerThumbActive: 'rgba(255, 255, 255, 0.25)',
      explorerTrackHover: 'rgba(255, 255, 255, 0.04)',
      explorerTrackActive: 'rgba(255, 255, 255, 0.08)',
    },

    // === Dialog / Modal ===
    dialog: {
      backdrop: 'rgba(0, 0, 0, 0.75)',
      bg: 'rgba(15, 15, 15, 0.98)',
      border: 'rgba(254, 16, 99, 0.15)',
    },

    // === Terminal ANSI palette ===
    terminal: {
      background: '#0a0a0a',
      foreground: '#d4d4d4',
      cursor: '#ffffff',
      cursorAccent: '#0a0a0a',
      selectionBackground: 'rgba(254, 16, 99, 0.25)',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#e5e5e5',

      // --- Refined shell chrome ---
      // Centralizes values that the shell-styled surface previously hard-coded inline so the
      // surface stays a single source of truth (and unblocks multi-theme).
      // Values intentionally preserve the prior low-alpha look exactly.
      titlebarBg: 'rgba(0, 0, 0, 0.45)',
      statusbarBg: 'rgba(0, 0, 0, 0.2)',
      chromeHairline: 'rgba(255, 255, 255, 0.05)',
      chromeHairlineFaint: 'rgba(255, 255, 255, 0.04)',
      userText: '#f2ecff',
      assistantText: '#b9c7d9',
      assistantRail: 'rgba(17, 168, 205, 0.28)',
      inlineCode: '#e6a1c0',
    },

    // === Markdown / Code rendering ===
    markdown: {
      strong: '#ffffff',
      emphasis: '#a371f7',
      link: '#FE1063',
    },

    // === Menu ===
    menu: {
      bg: '#141414',
      border: '#262626',
      separator: '#1a1a1a',
      text: '#e6e6e6',
      hover: 'rgba(254, 16, 99, 0.12)',
    },

    // === Shortcut badge ===
    badge: {
      bg: 'rgba(255, 255, 255, 0.06)',
      notificationBg: '#FE1063',
      notificationText: 'white',
      notificationBorder: 'rgba(254, 16, 99, 0.3)',
    },

    // === File extension colors (per-language / format) ===
    fileExtension: {
      js: '#f7df1e',
      jsx: '#61dafb',
      ts: '#3178c6',
      tsx: '#3178c6',
      css: '#1572b6',
      scss: '#cf649a',
      html: '#e34f26',
      json: '#ffff00',
      md: '#0066cc',
      vue: '#4fc08d',
      py: '#3776ab',
      rs: '#ce422b',
      go: '#00add8',
      java: '#ed8b00',
      php: '#777bb4',
      rb: '#cc342d',
      swift: '#fa7343',
      kt: '#7f52ff',
      dart: '#0175c2',
      yaml: '#cb171e',
      yml: '#cb171e',
      toml: '#9c4221',
      xml: '#e34f26',
      svg: '#ff9900',
      image: '#2ea043',
      pdf: '#dc2626',
      archive: '#d97706',
      npm: '#cb3837',
      docker: '#2496ed',
      default: '#8b949e',
    },

    // === File tree icon colors (per-type) ===
    fileIcon: {
      nodeModules: '#8cc84b',
      src: '#42a5f5',
      public: '#66bb6a',
      assets: '#ffa726',
      images: '#ec407a',
      components: '#26c6da',
      pages: '#ab47bc',
      hooks: '#ef5350',
      services: '#42a5f5',
      utils: '#78909c',
      lib: '#5c6bc0',
      api: '#26a69a',
      config: '#ff7043',
      styles: '#8d6e63',
      css: '#1976d2',
      sass: '#cf649a',
      docs: '#43a047',
      test: '#f57c00',
      build: '#795548',
      git: '#f05033',
      github: '#24292e',
      vscode: '#007acc',
      next: '#000000',
      nuxt: '#00c58e',
      android: '#3ddc84',
      ios: '#000000',
      generic: '#607d8b',
      database: '#4caf50',
      security: '#f44336',
      auth: '#ff9800',
      middleware: '#9c27b0',
      plugins: '#00bcd4',
      vendor: '#607d8b',
      defaultFolder: '#90caf9',
      npm: '#cc3534',
      yarn: '#2c8ebb',
      pnpm: '#f69220',
      docker: '#0db7ed',
      gitFile: '#f05033',
      readme: '#4caf50',
    },
  },

  // === Spacing ===
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    xxl: '32px',
  },

  // === Border radius ===
  radius: {
    sm: '2px',
    md: '4px',
    lg: '6px',
    xl: '8px',
    xxl: '12px',
    full: '9999px',
    scrollbar: '8px',
  },

  // === Font sizes ===
  fontSize: {
    xs: '11px',
    sm: '12px',
    md: '13px',
    lg: '14px',
    xl: '16px',
    xxl: '20px',
  },

  // === Font families ===
  fontFamily: {
    ui: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif',
    mono: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
  },

  // === Transitions ===
  transition: {
    fast: '0.1s ease',
    normal: '0.2s ease',
    slow: '0.3s ease',
  },

  // === Z-index layers ===
  zIndex: {
    dropdown: 100,
    modal: 200,
    overlay: 300,
    toast: 400,
  },

  // === Shadows ===
  shadow: {
    toolbar: '0 1px 3px rgba(0, 0, 0, 0.2)',
    panel: '0 2px 8px rgba(0, 0, 0, 0.3)',
    statusbar: 'inset 0 1px 0 rgba(255,255,255,0.04)',
    accentDrop: 'drop-shadow(0 0 4px rgba(254, 16, 99, 0.3))',
    greenDrop: 'drop-shadow(0 0 6px rgba(86, 211, 100, 0.3))',
    purpleDrop: 'drop-shadow(0 0 6px rgba(163, 113, 247, 0.3))',
    orangeDrop: 'drop-shadow(0 0 6px rgba(251, 133, 0, 0.3))',
    logoGlow: '0 8px 32px rgba(254, 16, 99, 0.3)',
    cardIconAccent: '0 8px 24px rgba(254, 16, 99, 0.3)',
    cardIconGreen: '0 8px 24px rgba(86, 211, 100, 0.3)',
    cardIconPurple: '0 8px 24px rgba(163, 113, 247, 0.3)',
    cardIconOrange: '0 8px 24px rgba(251, 133, 0, 0.3)',
    cardHover: '0 20px 40px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(254, 16, 99, 0.1)',
    dialogButton: '0 8px 16px rgba(254, 16, 99, 0.2)',
    sidebarOverlay: '4px 0 20px rgba(0,0,0,0.3)',
    tabBar: '0 1px 3px rgba(0,0,0,0.08)',
    tabActiveInset: 'inset 0 1px 0 rgba(254, 16, 99, 0.3)',
    overlay: '0 12px 40px rgba(0,0,0,0.4)',
  },

  // === Gradients ===
  gradient: {
    accentPrimary: 'linear-gradient(135deg, #FE1063 0%, #C10A69 100%)',
    accentPurple: 'linear-gradient(135deg, #a371f7 0%, #8250df 100%)',
    accentGreen: 'linear-gradient(135deg, #56d364 0%, #2ea043 100%)',
    accentOrange: 'linear-gradient(135deg, #fb8500 0%, #f77f00 100%)',
    heroTitle: 'linear-gradient(135deg, #e6edf3 0%, #FE1063 50%, #a371f7 100%)',
    logoTitle: 'linear-gradient(135deg, #FE1063 0%, #a371f7 100%)',
    shimmer: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)',
    cardLine: 'linear-gradient(90deg, transparent, rgba(254, 16, 99, 0.5), transparent)',
    welcomeBg: 'radial-gradient(ellipse at top, rgba(254, 16, 99, 0.05) 0%, transparent 50%), radial-gradient(ellipse at bottom, rgba(163, 108, 255, 0.03) 0%, transparent 50%)',
    tabBar: 'linear-gradient(180deg, #111111 0%, #0f0f0f 100%)',
    tabHoverOverlay: 'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, transparent 100%)',
    tabActiveBottom: 'linear-gradient(90deg, transparent, #FE1063, transparent)',
    breadcrumbFade: 'linear(to-r, transparent, rgba(10, 10, 10, 0.8))',
  },
} as const

export type Tokens = typeof tokens
