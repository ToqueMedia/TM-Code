export const meta = {
  name: 'team-byok-budget-360-redesign',
  description: 'Design a reusable TM/BYOK budget dashboard with an explicit view toggle (one active, other hidden)',
  phases: [
    { title: 'Understand', detail: 'map AccountTeam dashboard, TM-vs-BYOK data, UI toggle conventions' },
    { title: 'Design', detail: 'judge panel of 3 redesigns → one synthesized implementation spec' },
  ],
}

const WEB = '/Users/ithustle/dev/web/toquemedia-studio/packages/web'

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'components', 'viewModel', 'toggle', 'jsxSkeleton', 'fileChanges', 'i18nKeys', 'edgeCases'],
  properties: {
    summary: { type: 'string', description: 'One-paragraph pitch of this redesign' },
    components: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'kind', 'purpose'], properties: {
      name: { type: 'string' }, kind: { type: 'string', enum: ['new', 'edit', 'keep'] }, purpose: { type: 'string' },
      props: { type: 'array', items: { type: 'string' } }, file: { type: 'string' },
    } } },
    viewModel: { type: 'string', description: 'The normalized budget-view data model the reusable components consume (TM and BYOK both map to it)' },
    toggle: { type: 'object', additionalProperties: false, properties: {
      component: { type: 'string' }, placement: { type: 'string' }, states: { type: 'string' }, hides: { type: 'string' },
    } },
    jsxSkeleton: { type: 'string', description: 'Concrete JSX skeleton for the toggle + reusable components wired to the view model' },
    fileChanges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'change'], properties: { path: { type: 'string' }, change: { type: 'string' } } } },
    i18nKeys: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'en'], properties: { key: { type: 'string' }, en: { type: 'string' } } } },
    edgeCases: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'viewModel', 'newFiles', 'edits', 'componentApi', 'toggleUX', 'i18nKeys', 'edgeCases', 'implementationOrder'],
  properties: {
    overview: { type: 'string' },
    viewModel: { type: 'string', description: 'The exact normalized view-model TS shape the reusable components take' },
    newFiles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'purpose'], properties: { path: { type: 'string' }, purpose: { type: 'string' }, sketch: { type: 'string' } } } },
    edits: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'what'], properties: { path: { type: 'string' }, what: { type: 'string' } } } },
    componentApi: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'props'], properties: { name: { type: 'string' }, props: { type: 'string' }, notes: { type: 'string' } } } },
    toggleUX: { type: 'string', description: 'Exact toggle behavior: control type, default, states, what shows/hides, empty/disabled states' },
    i18nKeys: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'pt', 'en', 'fr', 'zh'], properties: { key: { type: 'string' }, pt: { type: 'string' }, en: { type: 'string' }, fr: { type: 'string' }, zh: { type: 'string' } } } },
    edgeCases: { type: 'array', items: { type: 'string' } },
    implementationOrder: { type: 'array', items: { type: 'string' } },
  },
}

phase('Understand')
const [dashMap, dataMap, conventions] = await parallel([
  () => agent(
    `Read ${WEB}/src/screens/account/AccountTeam.tsx in full. Produce a PRECISE map of the team BUDGET + MEMBERS dashboard: every sub-part (the recharts donut/PieChart, the capacity summary text, the donut legend, the slice alerts, the per-member usage list, the MemberRow component + its props, totals like planTotal, the allocation/reserve math, the % allocation EDITOR and how it writes via TeamService.setAllocation). For each: its purpose, the exact data/props it consumes, its line range, and whether it is presentational (easily extractable into a reusable component) vs stateful/wired. Also note where TeamByokSection is mounted and where the BYOK pool consumption currently renders. Be exhaustive and concrete — this drives a reusable-component refactor.`,
    { label: 'map:AccountTeam', phase: 'Understand', agentType: 'Explore' },
  ),
  () => agent(
    `Map the DATA available to drive a TM-vs-BYOK budget view. Read: ${WEB}/src/types/Team.ts, ${WEB}/src/screens/account/TeamByokSection.tsx, ${WEB}/src/services/teamByokService.ts. Report: (1) TM budget fields (tier budget, purchasedExtra, tokenBudget.tokensConsumed, members[].percentAllocation, members[].tokensConsumed) and where they come from; (2) BYOK fields (the pool from getTeamByok KV meta, team.byokBudget.consumed, members[].byokConsumed) and where they come from; (3) what is SHARED (the % allocation applies to both TM and BYOK); (4) the current TeamByokSection structure (config form fields + the pool field + the per-member breakdown I added) and what is config vs consumption. Goal: identify a single NORMALIZED "budget view" model that both TM and BYOK can map onto so the same components render either. Be concrete with field names and types.`,
    { label: 'map:data', phase: 'Understand', agentType: 'Explore' },
  ),
  () => agent(
    `Survey the web app's UI conventions for (a) a SEGMENTED CONTROL / TABS / TOGGLE to switch between two views, and (b) card/section styling. Search ${WEB}/src for existing tab/segmented/toggle components (Chakra Tabs, custom segmented controls, role="tab", SegmentedControl, view switchers in other screens), how show/hide of sections is done, the design tokens/colors used (look for a tokens or theme file and the CARD style constant in account screens), and the i18n pattern (flat dotted keys via useLanguage t()). Report concrete component names, import paths, and a recommended approach for an accessible TM⇄BYOK segmented toggle that matches house style.`,
    { label: 'map:conventions', phase: 'Understand', agentType: 'Explore' },
  ),
])

const understanding = [
  '# AccountTeam dashboard map', dashMap || '(none)',
  '\n# TM-vs-BYOK data model', dataMap || '(none)',
  '\n# UI conventions (toggle + cards)', conventions || '(none)',
].join('\n')

phase('Design')
const ANGLES = [
  { key: 'component-purist', lens: 'Extract pure presentational components (e.g. BudgetDonut, MemberAllocationList/Row, BudgetSummary, BudgetUsageBar) that each take a NORMALIZED budget-view model. The toggle merely swaps which model is passed. Eliminate prop drilling via one well-shaped view object. The % allocation editor is shared and stays interactive in both views.' },
  { key: 'ux-first', lens: "Optimize the owner's mental model. One segmented switch at the top: [Plano TM] [BYOK]. Selecting one shows ONLY that budget's dashboard (donut + members + totals) and the other section disappears entirely. Nail empty/disabled states (no BYOK pool set, BYOK disabled, member 0%). The switch should default to the budget that actually governs coding (BYOK when a pool is active, else TM). Minimize cognitive load; zero ambiguity about which budget is shown." },
  { key: 'pragmatic-safe', lens: 'Reuse as much of the existing AccountTeam JSX as possible by parameterizing it, to keep the diff safe on a large file. Favor a single source-of-truth toggle state + a derived view model, extracting components incrementally. Avoid a risky big-bang rewrite while still delivering the full reusable + toggle outcome.' },
]
const proposals = await parallel(ANGLES.map((a) => () =>
  agent(
    `You are designing a COMPLETE (360) UI/UX redesign of the team budget dashboard in a React + Chakra UI app.

USER INTENT (verbatim, frustrated after two failed attempts): "Os gráficos, a secção do membro, membros tudo devia ser reusável e ter algo que activando um e usando outro, uma secção desaparece. A mudança da UI/UX deve ser 360." → The charts, the member section, and the members list must be REUSABLE components; there must be an explicit control where ACTIVATING one source and using the other makes one section DISAPPEAR; it must be a complete redesign, not patches.

WHAT WAS REJECTED (do NOT repeat): silently swapping the TM budget widget's data source under a hidden flag to show BYOK numbers, and duplicating the pool consumption in two places. The user called it amateur/more confusing. The fix is an EXPLICIT user-controlled toggle + genuinely reusable components + exactly one place per number.

DESIGN ANGLE for your proposal: ${a.lens}

CONTEXT (current code map):
${understanding}

HARD CONSTRAINTS: Chakra UI; match house conventions; the % allocation is SHARED between TM and BYOK (same editor drives both); BYOK pool comes from getTeamByok (KV meta) while BYOK consumption is in the team doc (byokBudget.consumed + members[].byokConsumed); TM budget = tier pie + purchasedExtra with tokensConsumed; the data-plane gate keeps 0%-slice members blocked (do not change). Bilingual i18n (pt/en/fr/zh) via t().

Produce a concrete, implementation-ready design: the normalized budget-view model; the reusable components (names, props, which file); the toggle (component, placement, default, states, what hides); a real JSX skeleton wiring the toggle + components to the model; the file changes (new files + edits to AccountTeam.tsx and TeamByokSection.tsx); i18n keys; and edge cases (no pool, BYOK disabled, single member, member at 0%). Specific enough to implement directly.`,
    { label: `design:${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA },
  )
))

const valid = proposals.filter(Boolean)
log(`Got ${valid.length}/3 design proposals; synthesizing the best spec.`)

const synthesis = await agent(
  `Synthesize ONE best, implementation-ready spec from these ${valid.length} design proposals for the team TM/BYOK budget 360 redesign. Choose the strongest spine, graft the best ideas from the others, resolve conflicts decisively, and remove anything that re-introduces the rejected pattern (hidden data-swap, duplicated numbers).

MUST satisfy the user intent: (1) the charts (donut), the member section, and the members list are REUSABLE components fed by a normalized view model; (2) an EXPLICIT segmented toggle [Plano TM | BYOK] where selecting one shows that budget's dashboard and the OTHER section DISAPPEARS; (3) a complete, coherent redesign; (4) exactly one place per number, no duplication; (5) the % allocation editor is shared and works in both views.

CONSTRAINTS recap: Chakra UI + house conventions; BYOK pool from getTeamByok, consumption from team doc; TM from tier pie; gate 0%→blocked unchanged; default the toggle to the budget that governs coding (BYOK if pool active, else TM); i18n in ALL FOUR locales (pt/en/fr/zh) with concrete strings.

PROPOSALS (JSON):
${JSON.stringify(valid, null, 2)}

Return the final spec: overview; the exact normalized viewModel TS shape; newFiles (path + purpose + a real sketch) and edits (path + what); the componentApi (name + props + notes) for every reusable component; the precise toggleUX (control, default, what shows/hides, empty + disabled states); i18nKeys with pt/en/fr/zh; edgeCases; and a step-by-step implementationOrder a single engineer can follow without re-deciding anything.`,
  { label: 'synthesize-spec', phase: 'Design', schema: SPEC_SCHEMA, effort: 'high' },
)

return synthesis
