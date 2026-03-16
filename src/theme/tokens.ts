// src/theme/tokens.ts — Single source of truth for all design values

export const tokens = {
  colors: {
    // === Backgrounds (Lighter Dark / Charcoal) ===
    bg: {
      app: '#2b2d33',
      welcome: '#1e2028',
      sidebar: '#2f3138',
      overlay: '#383b42',
      titlebar: 'rgba(47, 49, 56, 0.95)',
      activitybar: '#3c3f46',
      statusbar: '#1e2030',
      terminal: '#22242a',
      input: 'rgba(34, 38, 46, 0.8)',
      hover: '#3a6ea5',
      hoverSubtle: 'rgba(139, 148, 158, 0.12)',
      selection: '#3a6ea5',
      activeItem: '#2a4a6a',
      glass: 'rgba(43, 45, 51, 0.92)',
      card: 'rgba(34, 38, 46, 0.6)',
      cardBorder: 'rgba(68, 74, 81, 0.8)',
      codeBlock: '#282b32',
      codeInline: 'rgba(130, 138, 149, 0.15)',
      codeBlockHeader: '#363940',
      dark: '#24262c',
      mainLayout: '#1e2025',
      sidebarBackdrop: 'rgba(0,0,0,0.25)',
      sidebarGlass: 'rgba(30, 32, 38, 0.85)',
      tabHover: '#40434a',
      footerOverlay: 'rgba(255, 255, 255, 0.02)',
      whiteMicro: 'rgba(255, 255, 255, 0.01)',
      whiteHover: 'rgba(255, 255, 255, 0.04)',
      whiteOverlay: 'rgba(255, 255, 255, 0.1)',
      whiteSubtle: 'rgba(255, 255, 255, 0.06)',
      blackOverlay: 'rgba(0, 0, 0, 0.4)',
      blackOverlayStrong: 'rgba(0, 0, 0, 0.5)',
      panel: '#262a30',
      panelAlt: '#2c3038',
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
      default: '#484b54',
      subtle: '#3a3d44',
      input: 'rgba(68, 74, 81, 0.8)',
      inputAlt: '#3c4a5c',
      glass: 'rgba(76, 80, 86, 0.6)',
      focus: '#FE1063',
      statusbar: '#2a3548',
      activitybar: '#32343a',
      sidebar: 'rgba(68, 74, 81, 0.5)',
      sidebarPanel: '#333840',
      panel: '#40464d',
      tab: '#2f3138',
      footer: '#505560',
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
      userBubble: '#2a3a4c',
      assistantBubble: '#383b42',
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
      thumb: '#4c4f56',
      thumbHover: '#5a5d64',
      track: 'transparent',
      explorerThumb: 'rgba(128, 128, 128, 0.4)',
      explorerThumbHover: 'rgba(128, 128, 128, 0.6)',
      explorerThumbActive: 'rgba(128, 128, 128, 0.8)',
      explorerTrackHover: 'rgba(128, 128, 128, 0.2)',
      explorerTrackActive: 'rgba(128, 128, 128, 0.4)',
    },

    // === Dialog / Modal ===
    dialog: {
      backdrop: 'rgba(0, 0, 0, 0.7)',
      bg: 'rgba(36, 38, 44, 0.96)',
      border: 'rgba(68, 74, 81, 0.8)',
    },

    // === Terminal ANSI palette ===
    terminal: {
      background: '#22242a',
      foreground: '#d4d4d4',
      cursor: '#ffffff',
      cursorAccent: '#22242a',
      selectionBackground: '#3a6ea5',
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
    },

    // === Markdown / Code rendering ===
    markdown: {
      strong: '#ffffff',
      emphasis: '#a371f7',
      link: '#FE1063',
    },

    // === Menu ===
    menu: {
      bg: '#383b42',
      border: '#4c4f56',
      separator: '#4c4f56',
      text: '#e6e6e6',
      hover: '#3a6ea5',
    },

    // === Shortcut badge ===
    badge: {
      bg: 'rgba(110, 118, 129, 0.1)',
      notificationBg: '#007acc',
      notificationText: 'white',
      notificationBorder: '#3c3f46',
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
    tabBar: 'linear-gradient(180deg, #383b42 0%, #2f3138 100%)',
    tabHoverOverlay: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 100%)',
    tabActiveBottom: 'linear-gradient(90deg, transparent, #FE1063, transparent)',
    breadcrumbFade: 'linear(to-r, transparent, rgba(30, 32, 37, 0.8))',
  },
} as const

export type Tokens = typeof tokens
