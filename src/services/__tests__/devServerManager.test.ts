import {
  URL_REGEX_GLOBAL,
  PORT_REGEX,
  PORT_FAILURE_REGEX,
  commandLooksLikeWrapper,
  classifyProbedUrl,
  extractScriptName,
  resolveIsWrapper,
  type ClassifySlotState,
} from '../devServerDetection'

function emptySlot(projectKind: 'frontend' | 'backend' | 'fullstack'): ClassifySlotState {
  return { projectKind, frontendUrl: null, backendUrl: null, backendUrlMirrored: false }
}

function classify(url: string, kind: 'html' | 'json' | 'other' | null, slot: ClassifySlotState, frontendPortHint?: number) {
  return classifyProbedUrl(url, kind, slot, frontendPortHint)
}

describe('URL_REGEX_GLOBAL', () => {
  beforeEach(() => { URL_REGEX_GLOBAL.lastIndex = 0 })

  it('captures a single localhost URL', () => {
    const line = 'Local:   http://localhost:7773/'
    const matches = line.match(URL_REGEX_GLOBAL)
    expect(matches).toEqual(['http://localhost:7773/'])
  })

  it('captures multiple URLs in one line (fullstack scenarios)', () => {
    const line = 'Server running at http://localhost:7777, preview http://127.0.0.1:7773'
    const matches = line.match(URL_REGEX_GLOBAL)
    expect(matches).toHaveLength(2)
    expect(matches).toContain('http://localhost:7777')
    expect(matches).toContain('http://127.0.0.1:7773')
  })

  it('matches IPv6 variants', () => {
    const line = 'Listening at http://[::1]:7773'
    const matches = line.match(URL_REGEX_GLOBAL)
    expect(matches).toEqual(['http://[::1]:7773'])
  })

  it('matches 0.0.0.0 bindings', () => {
    const line = 'http://0.0.0.0:3000 ready'
    const matches = line.match(URL_REGEX_GLOBAL)
    expect(matches).toEqual(['http://0.0.0.0:3000'])
  })

  it('does NOT match URLs without a port', () => {
    const line = 'Visit http://localhost/dashboard'
    const matches = line.match(URL_REGEX_GLOBAL)
    expect(matches).toBeNull()
  })
})

describe('PORT_REGEX', () => {
  it('matches "listening on port N"', () => {
    const m = 'Express app listening on port 7777'.match(PORT_REGEX)
    expect(m?.[1]).toBe('7777')
  })

  it('matches "running at port N"', () => {
    const m = 'Server running at port 3000'.match(PORT_REGEX)
    expect(m?.[1]).toBe('3000')
  })

  it('matches "server on N"', () => {
    const m = 'server on 8080'.match(PORT_REGEX)
    expect(m?.[1]).toBe('8080')
  })

  it('does NOT match bare "port N" (ambiguous — could be error)', () => {
    const m = 'Port 7773 already in use, retrying on 7774'.match(PORT_REGEX)
    // The old over-eager regex would capture 7773 here. The new one should not.
    // It may match the "retrying on" phrase IF we allowed it, but our regex
    // demands explicit success verbs.
    expect(m).toBeNull()
  })
})

describe('PORT_FAILURE_REGEX', () => {
  it('matches EADDRINUSE', () => {
    expect(PORT_FAILURE_REGEX.test('Error: listen EADDRINUSE: address already in use :::7773')).toBe(true)
  })

  it('matches "address already in use"', () => {
    expect(PORT_FAILURE_REGEX.test('address already in use')).toBe(true)
  })

  it('matches "retrying on port N"', () => {
    expect(PORT_FAILURE_REGEX.test('Retrying on port 7775')).toBe(true)
  })

  it('does NOT match healthy startup lines', () => {
    expect(PORT_FAILURE_REGEX.test('Server ready at http://localhost:7773')).toBe(false)
    expect(PORT_FAILURE_REGEX.test('Listening on port 7777')).toBe(false)
  })
})

describe('classifyProbedUrl — content-type-driven, port-agnostic by default', () => {
  describe('frontend-only project — first URL wins regardless of port', () => {
    it('Vite default 5173 → frontend', () => {
      const actions = classify('http://127.0.0.1:5173/', 'html', emptySlot('frontend'))
      expect(actions).toEqual([{ type: 'assignFrontend', url: 'http://127.0.0.1:5173/' }])
    })

    it('Next.js 3000 → frontend', () => {
      const actions = classify('http://127.0.0.1:3000/', 'html', emptySlot('frontend'))
      expect(actions).toEqual([{ type: 'assignFrontend', url: 'http://127.0.0.1:3000/' }])
    })

    it('subsequent URLs ignored once frontendUrl is set', () => {
      const slot: ClassifySlotState = {
        projectKind: 'frontend',
        frontendUrl: 'http://127.0.0.1:5173/',
        backendUrl: null,
        backendUrlMirrored: false,
      }
      expect(classify('http://127.0.0.1:5174/', 'html', slot)).toEqual([])
    })
  })

  describe('backend-only project — first URL wins regardless of port or content-type', () => {
    it('Express on 8080 with JSON → backend', () => {
      const actions = classify('http://127.0.0.1:8080/', 'json', emptySlot('backend'))
      expect(actions).toEqual([{ type: 'assignBackend', url: 'http://127.0.0.1:8080/', mirrored: false }])
    })

    it('Express serving static HTML → backend (single-kind ignores content-type)', () => {
      const actions = classify('http://127.0.0.1:3000/', 'html', emptySlot('backend'))
      expect(actions).toEqual([{ type: 'assignBackend', url: 'http://127.0.0.1:3000/', mirrored: false }])
    })
  })

  describe('fullstack — content-type drives classification', () => {
    it('Vite (HTML) at any port → frontend + mirror backend (monolithic case)', () => {
      const actions = classify('http://127.0.0.1:5173/', 'html', emptySlot('fullstack'))
      expect(actions).toEqual([
        { type: 'assignFrontend', url: 'http://127.0.0.1:5173/' },
        { type: 'assignBackend', url: 'http://127.0.0.1:5173/', mirrored: true },
      ])
    })

    it('Express (JSON) at any port → backend', () => {
      const actions = classify('http://127.0.0.1:3000/', 'json', emptySlot('fullstack'))
      expect(actions).toEqual([{ type: 'assignBackend', url: 'http://127.0.0.1:3000/', mirrored: false }])
    })

    it('Express returning HTML (static fallback) → frontend (content-type wins)', () => {
      // Express serves Vite build with text/html content-type. Without a port
      // convention, we trust the content-type. If the user's setup needs the
      // opposite, they pass a frontend_port_hint.
      const actions = classify('http://127.0.0.1:7777/', 'html', emptySlot('fullstack'))
      expect(actions).toEqual([
        { type: 'assignFrontend', url: 'http://127.0.0.1:7777/' },
        { type: 'assignBackend', url: 'http://127.0.0.1:7777/', mirrored: true },
      ])
    })

    it('"other" content-type → backend (e.g., text/plain, octet-stream)', () => {
      const actions = classify('http://127.0.0.1:8080/', 'other', emptySlot('fullstack'))
      expect(actions).toEqual([{ type: 'assignBackend', url: 'http://127.0.0.1:8080/', mirrored: false }])
    })

    it('null content-type (probe inconclusive) → no action', () => {
      const actions = classify('http://127.0.0.1:5173/', null, emptySlot('fullstack'))
      expect(actions).toEqual([])
    })

    it('distributed: HTML first then JSON — mirror overwritten by real backend', () => {
      let slot = emptySlot('fullstack')
      const viteActions = classify('http://127.0.0.1:5173/', 'html', slot)
      expect(viteActions).toEqual([
        { type: 'assignFrontend', url: 'http://127.0.0.1:5173/' },
        { type: 'assignBackend', url: 'http://127.0.0.1:5173/', mirrored: true },
      ])

      slot = {
        projectKind: 'fullstack',
        frontendUrl: 'http://127.0.0.1:5173/',
        backendUrl: 'http://127.0.0.1:5173/',
        backendUrlMirrored: true,
      }

      const expressActions = classify('http://127.0.0.1:3000/', 'json', slot)
      expect(expressActions).toEqual([
        { type: 'assignBackend', url: 'http://127.0.0.1:3000/', mirrored: false },
      ])
    })

    it('distributed: JSON first then HTML — real backend preserved, frontend assigned, no mirror', () => {
      const slot: ClassifySlotState = {
        projectKind: 'fullstack',
        frontendUrl: null,
        backendUrl: 'http://127.0.0.1:3000/',
        backendUrlMirrored: false,
      }
      const viteActions = classify('http://127.0.0.1:5173/', 'html', slot)
      // Frontend assigned. Mirror NOT triggered because backend is real (non-mirrored).
      expect(viteActions).toEqual([
        { type: 'assignFrontend', url: 'http://127.0.0.1:5173/' },
      ])
    })

    it('frontendPortHint forces classification when content-type ambiguous', () => {
      // Both servers might respond with HTML in some configurations. The hint
      // says: "treat the URL on this port as frontend".
      const slot = emptySlot('fullstack')
      const actions = classify('http://127.0.0.1:7773/', 'other', slot, 7773)
      expect(actions).toEqual([
        { type: 'assignFrontend', url: 'http://127.0.0.1:7773/' },
      ])
    })

    it('frontendPortHint with HTML still mirrors (monolithic case)', () => {
      const slot = emptySlot('fullstack')
      const actions = classify('http://127.0.0.1:7773/', 'html', slot, 7773)
      expect(actions).toEqual([
        { type: 'assignFrontend', url: 'http://127.0.0.1:7773/' },
        { type: 'assignBackend', url: 'http://127.0.0.1:7773/', mirrored: true },
      ])
    })
  })
})

describe('commandLooksLikeWrapper', () => {
  it('detects concurrently', () => {
    expect(commandLooksLikeWrapper('concurrently "npm:a" "npm:b"')).toBe(true)
  })

  it('detects npm-run-all', () => {
    expect(commandLooksLikeWrapper('npm-run-all --parallel dev:server dev:client')).toBe(true)
  })

  it('detects turbo', () => {
    expect(commandLooksLikeWrapper('turbo run dev')).toBe(true)
    expect(commandLooksLikeWrapper('turbo dev')).toBe(true)
  })

  it('detects pnpm -r', () => {
    expect(commandLooksLikeWrapper('pnpm -r dev')).toBe(true)
  })

  it('detects workspaces fanout', () => {
    expect(commandLooksLikeWrapper('npm run dev --workspaces')).toBe(true)
  })

  it('does NOT flag plain dev scripts', () => {
    expect(commandLooksLikeWrapper('npm run dev')).toBe(false)
    expect(commandLooksLikeWrapper('vite --port 7773')).toBe(false)
    expect(commandLooksLikeWrapper('npx tsx src/server.ts')).toBe(false)
  })
})

describe('extractScriptName', () => {
  it('extracts from npm run <script>', () => {
    expect(extractScriptName('npm run dev')).toBe('dev')
  })

  it('extracts from pnpm <script> (short form)', () => {
    expect(extractScriptName('pnpm start')).toBe('start')
  })

  it('extracts hyphenated and colon scripts', () => {
    expect(extractScriptName('npm run dev:client')).toBe('dev:client')
    expect(extractScriptName('yarn run db-migrate')).toBe('db-migrate')
  })

  it('returns null for non-script commands', () => {
    expect(extractScriptName('vite --port 7773')).toBeNull()
    expect(extractScriptName('concurrently "a" "b"')).toBeNull()
    expect(extractScriptName('tsx src/server.ts')).toBeNull()
  })
})

describe('resolveIsWrapper — recursive script indirection', () => {
  it('matches direct wrapper command (depth 0)', () => {
    const lookup = () => null
    expect(resolveIsWrapper('concurrently "a" "b"', lookup)).toBe(true)
  })

  it('matches when top-level is a run but script body is a wrapper (depth 1)', () => {
    const scripts: Record<string, string> = { dev: 'concurrently "a" "b"' }
    const lookup = (n: string) => scripts[n] ?? null
    expect(resolveIsWrapper('npm run dev', lookup)).toBe(true)
  })

  it('follows a chain: dev → start → concurrently (depth 2)', () => {
    const scripts: Record<string, string> = {
      dev: 'npm run start',
      start: 'concurrently "a" "b"',
    }
    const lookup = (n: string) => scripts[n] ?? null
    expect(resolveIsWrapper('npm run dev', lookup)).toBe(true)
  })

  it('follows a deeper chain: a → b → c (wrapper) within maxDepth=3', () => {
    // 3 commands, 2 lookups. maxDepth=3 easily catches it.
    const scripts: Record<string, string> = {
      a: 'npm run b',
      b: 'turbo run c',
    }
    const lookup = (n: string) => scripts[n] ?? null
    expect(resolveIsWrapper('npm run a', lookup, 3)).toBe(true)
  })

  it('catches wrapper at the exact maxDepth boundary', () => {
    // 4 commands, 3 lookups. The wrapper sits at depth=3.
    const scripts: Record<string, string> = {
      a: 'npm run b',
      b: 'npm run c',
      c: 'concurrently "..."',
    }
    const lookup = (n: string) => scripts[n] ?? null
    expect(resolveIsWrapper('npm run a', lookup, 3)).toBe(true)
  })

  it('stops past maxDepth — wrapper beyond the limit is not detected', () => {
    // 5 commands, 4 lookups needed. maxDepth=3 cuts off before the wrapper.
    const scripts: Record<string, string> = {
      a: 'npm run b',
      b: 'npm run c',
      c: 'npm run d',
      d: 'concurrently "..."',
    }
    const lookup = (n: string) => scripts[n] ?? null
    expect(resolveIsWrapper('npm run a', lookup, 3)).toBe(false)
    // A tighter budget of 2 misses it even earlier.
    expect(resolveIsWrapper('npm run a', lookup, 2)).toBe(false)
  })

  it('returns false when no wrapper is found in the chain', () => {
    const scripts: Record<string, string> = {
      dev: 'npm run start',
      start: 'vite --port 7773',
    }
    const lookup = (n: string) => scripts[n] ?? null
    expect(resolveIsWrapper('npm run dev', lookup)).toBe(false)
  })

  it('handles circular scripts without infinite recursion', () => {
    // Pathological: dev → dev. Must not loop.
    const scripts: Record<string, string> = {
      dev: 'npm run dev',
    }
    const lookup = (n: string) => scripts[n] ?? null
    expect(resolveIsWrapper('npm run dev', lookup)).toBe(false)
  })

  it('returns false when the script body is another non-run command', () => {
    const scripts: Record<string, string> = {
      dev: 'node build.js',
    }
    const lookup = (n: string) => scripts[n] ?? null
    expect(resolveIsWrapper('npm run dev', lookup)).toBe(false)
  })

  it('returns false when lookup has no entry', () => {
    const lookup = () => null
    expect(resolveIsWrapper('npm run nonexistent', lookup)).toBe(false)
  })
})

describe('HTML-error race regression — Express 404 must not steal frontendUrl', () => {
  // The bug this guards: Express boots first and serves "Cannot GET /"
  // (text/html, status 404). The probe used to classify this as HTML and
  // assign it to frontendUrl. Vite arriving seconds later with real 200 HTML
  // would then be ignored because frontendUrl was already set.
  //
  // Defense layer 1 (Rust probe): downgrade HTML+status>=400 to kind='other'.
  // Defense layer 2 (classifier): when kind='other', goes to backendUrl.
  // Defense layer 3 (port hint): if Vite's port is known up front, force the
  // 200 HTML response to frontend regardless of what arrived first.
  //
  // The classifier test exercises the layer-2/3 cooperation — Express HTML
  // gets demoted by the probe (already tested in Rust); we validate the
  // downstream behaviour here.

  it('Express 404 (demoted to kind=other) → backendUrl, Vite 200 HTML → frontendUrl', () => {
    let slot = emptySlot('fullstack')

    // Express probes first. Rust probe has already downgraded the HTML 404
    // to 'other' before this call (status-aware logic in probe_server).
    const expressActions = classify('http://127.0.0.1:3000/', 'other', slot)
    expect(expressActions).toEqual([{ type: 'assignBackend', url: 'http://127.0.0.1:3000/', mirrored: false }])

    slot = { ...slot, backendUrl: 'http://127.0.0.1:3000/', backendUrlMirrored: false }

    // Vite arrives later with real 200 HTML. The frontend slot is still
    // empty, so it claims it without contention.
    const viteActions = classify('http://127.0.0.1:5173/', 'html', slot)
    expect(viteActions).toEqual([{ type: 'assignFrontend', url: 'http://127.0.0.1:5173/' }])
  })

  it('frontendPortHint forces 5173 → frontend even if probed before content-type', () => {
    // Belt-and-braces: even if Vite's first response happens to be ambiguous
    // (e.g. 'other'), the port hint pins it to the frontend slot.
    const slot = emptySlot('fullstack')
    const actions = classify('http://127.0.0.1:5173/', 'other', slot, 5173)
    // Port-hint matches → forced into frontend slot (mirror is only added
    // when content-type is HTML; 'other' alone is the trigger).
    expect(actions).toContainEqual({ type: 'assignFrontend', url: 'http://127.0.0.1:5173/' })
  })
})
