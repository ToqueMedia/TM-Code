/**
 * Evidência do PROJECTO para a selecção de contexto auxiliar.
 *
 * Porquê isto existe (achado #9, 2026-08-05): a lista `BOUNDED_INLINE_CONTEXTS`
 * é fixa e cega ao projecto. Medido numa sessão real de 114 pedidos num
 * projecto de backend, cinco secções de `design_system` mais `ui_patterns`
 * entraram em TODOS os pedidos. Medido o conteúdo REAL renderizado (não o
 * `estTokens` declarado), essas seis secções são texto ESTÁTICO — não derivam
 * do projecto, portanto não "encolhem" sozinhas num repo sem design system:
 *
 *   design_system.semantic_tokens     425 chars ≈ 142 tokens
 *   design_system.theme_config        302 chars ≈ 101 tokens
 *   design_system.brand_palette       203 chars ≈  68 tokens
 *   design_system.chakra_recipes      200 chars ≈  67 tokens
 *   design_system.component_patterns 2591 chars ≈ 864 tokens
 *   ui_patterns                      1242 chars ≈ 414 tokens
 *                                            ────────────────
 *                                              ≈ 1 656 tokens/pedido
 *
 * O critério aqui é EVIDÊNCIA DO PROJECTO, nunca inferência sobre a tarefa —
 * foi por classificar a tarefa que o Intent Router morreu (uma classificação
 * "read-only" errada negou create/edit num run inteiro). O projecto é estável
 * entre turnos e verificável a olho.
 *
 * ── Duas regras que evitam o modo de falha silenciosa ──
 *
 * 1. **Ausência de dados NÃO é evidência negativa.** Um projecto vazio (sem
 *    package.json e sem ficheiros-fonte) mantém TUDO. Só se omite quando há
 *    evidência positiva de um projecto substancial SEM a superfície em causa.
 *    Sem isto, criar uma app de raiz — o momento em que a linha de base de
 *    gosto de UI mais vale — nascia sem ela.
 * 2. **O portão não é pegajoso.** É reavaliado a cada build do prompt e o
 *    `fsVersion` entra na chave de cache, portanto no turno seguinte a escrever
 *    o primeiro `.tsx` (ou a instalar Tailwind) as secções voltam sozinhas.
 *
 * Os sinais são de propósito GENEROSOS (dir `components/`, `templates/`,
 * `client/`, qualquer `.css`): erram para o lado de entregar. O único caso que
 * perde secções é o que não tem nada disto — um backend/CLI/lib puro.
 */

import type { PackageSummary } from './types'

/**
 * Dependências que provam um SISTEMA DE DESIGN (tokens, tema, receitas).
 * Subconjunto de evidência de UI: quem tem isto tem UI.
 */
const DESIGN_SYSTEM_DEPS = new Set([
  'tailwindcss', '@chakra-ui/react', '@chakra-ui/system', '@mui/material',
  '@mui/joy', '@emotion/react', 'styled-components', 'antd', 'bootstrap',
  '@mantine/core', '@radix-ui/themes', 'daisyui', '@vanilla-extract/css',
  '@stitches/react', 'stylex', '@shopify/polaris', 'primereact', 'sass', 'less',
])

/**
 * Frameworks que provam que o projecto TEM build/servidor próprio — inclui os
 * de backend, ao contrário de `UI_DEPS`. Consumido por `isVanillaWeb`, que
 * decide se o prompt injeta as regras de "site sem build".
 */
const FRAMEWORK_DEPS = new Set([
  'react', 'next', 'vue', 'nuxt', 'svelte', '@angular/core', 'astro',
  'solid-js', 'express', 'fastify', '@nestjs/core',
])

/** Extensões que provam que o projecto TEM código (não está vazio). */
const SOURCE_FILE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|java|kt|swift|cs|ex|exs|dart|c|cc|cpp|h|hpp|vue|svelte|astro|html|css|scss)\b/i

/**
 * Ficheiros/pastas que indiciam superfície de TEMA / design tokens.
 *
 * Um `.css` solto NÃO conta, de propósito: as três secções que este sinal
 * guarda (semantic_tokens, theme_config, brand_palette) mandam "localizar os
 * ficheiros de tema/token existentes" e listam `src/theme/**`. Num projecto com
 * um `index.css` e mais nada, esses caminhos não existem — a secção é um
 * ponteiro para o vazio, que é pior do que não a ter.
 */
const THEME_SURFACE = /(tailwind\.config\.|theme\.(ts|tsx|js|json|css)|(^|[/\s])(theme|themes|styles|design-system|design_system|tokens)(\/|\s|$))/im

export interface ProjectContextEvidence {
  /**
   * O projecto tem conteúdo reconhecível — ficheiro-fonte na árvore OU pelo
   * menos uma dependência declarada. Falso = "não sei", não "não tem".
   *
   * Deliberadamente NÃO conta: um `package.json` sozinho (o `npm init -y` gera
   * logo um script `test`, portanto contar scripts punha uma pasta vazia a
   * parecer um projecto feito), nem uma árvore ilegível.
   */
  hasProjectContent: boolean
  /**
   * A lista de dependências é DESCONHECIDA — não vazia. Sem `package.json`,
   * com JSON inválido, ou com a pasta aberta um nível abaixo do manifesto do
   * monorepo. Distinguir isto de "não tem dependências" é o que impede o
   * portão de reter por falta de dados (ver o gate).
   */
  depsUnknown: boolean
  /** O projecto tem tema / design tokens (ficheiro de tema ou dep de design system). */
  hasThemeSurface: boolean
  /** Chakra UI está declarado nas dependências. */
  hasChakra: boolean
  /**
   * O projecto declara um framework com build/servidor próprio (front OU
   * back). Consumido por `isVanillaWeb` no contextBuilder — a negação disto é
   * que faz o prompt injetar as regras de "site sem build".
   */
  hasFrameworkDeps: boolean
  /** Sinais legíveis que suportaram a decisão (telemetria/export). */
  signals: string[]
}

/**
 * NOTA sobre os limites das entradas: `treeString` vem com `maxDepth: 2` e
 * `pkgSummary.dependencies` vem truncada a 15/10 — por isso a detecção usa
 * `detectionDependencies` (união completa, incluindo sub-pacotes de workspace).
 * Ambos os limites empurram para o falso NEGATIVO, e é por isso que os sinais
 * de pasta acima são largos: num monorepo basta a pasta `client/` ou `web/`.
 */
export function detectProjectContextEvidence(input: {
  pkgSummary: PackageSummary | null | undefined
  treeString: string | null | undefined
}): ProjectContextEvidence {
  const tree = input.treeString ?? ''
  const deps = input.pkgSummary?.detectionDependencies ?? []
  const signals: string[] = []

  const dsDep = deps.find(d => DESIGN_SYSTEM_DEPS.has(d))
  const hasChakra = deps.some(d => d.startsWith('@chakra-ui/'))
  const themeFile = THEME_SURFACE.test(tree)

  if (dsDep) signals.push(`dep:${dsDep}`)
  if (hasChakra) signals.push('dep:@chakra-ui')
  if (themeFile) signals.push('file:theme-surface')

  // `buildFileTree` devolve este sentinela quando a leitura falha. Sem o
  // tratar, uma falha de I/O passava por "projecto sem UI" e o portão retinha
  // TUDO — um erro transitório a degradar o prompt, calado. Falha de leitura é
  // ausência de dados, e ausência de dados não decide nada.
  const treeReadable = tree.length > 0 && !tree.startsWith('(Could not read')
  const hasProjectContent = (treeReadable && SOURCE_FILE_EXT.test(tree)) || deps.length > 0
  if (!hasProjectContent) signals.push('project:empty-or-unreadable')

  // `pkgSummary` é null quando não há `package.json` OU quando ele não faz
  // parse (extractPackageSummary devolve null nos dois casos). Isso NÃO
  // significa "projecto sem dependências": significa que não sabemos.
  //
  // A distinção é o que faltava. `hasProjectContent` é um OR entre árvore e
  // deps, portanto bastava a ÁRVORE ser legível para o portão ficar activo com
  // `deps = []` — e um `package.json` a meio de uma edição, um projecto Deno,
  // ou uma pasta aberta abaixo do manifesto do monorepo retinham quatro
  // secções num projecto de UI a sério, em silêncio (auditoria 06-08).
  const depsUnknown = !input.pkgSummary
  if (depsUnknown) signals.push('deps:unknown')

  // Estes campos dizem só o que foi DETECTADO. A política "ausência de dados
  // não é evidência negativa" vive no portão (evidenceOmittedAuxiliaries), num
  // sítio só — misturá-la aqui faria `hasUiSurface: true` significar duas
  // coisas diferentes conforme o projecto.
  return {
    hasProjectContent,
    depsUnknown,
    hasThemeSurface: Boolean(dsDep || themeFile),
    hasChakra,
    hasFrameworkDeps: deps.some(d => FRAMEWORK_DEPS.has(d)),
    signals,
  }
}

export interface EvidenceGateInput {
  evidence: ProjectContextEvidence
  /** A sessão tem (ou teve) uma imagem — ver `vision.image_rules`. */
  sessionHasImage: boolean
}

/**
 * Secções inline que a evidência do projecto NÃO justifica, com a razão.
 * A razão é entregue ao índice on-demand e à telemetria: a omissão fica
 * visível para o modelo E para quem lê o export, em vez de desaparecer.
 */
export function evidenceOmittedAuxiliaries(
  input: EvidenceGateInput,
): Array<{ id: string; reason: string }> {
  const { evidence, sessionHasImage } = input
  const out: Array<{ id: string; reason: string }> = []

  // Regra 1: ausência de dados NÃO é evidência negativa. Projecto vazio,
  // acabado de criar ou ilegível → entrega tudo, como antes deste portão
  // existir. É também o caso em que a linha de base de gosto de UI mais vale.
  if (!evidence.hasProjectContent) return out

  // `design_system.component_patterns` e `ui_patterns` NÃO são retidas por
  // evidência (2026-08-06). Foram, e mediu-se o preço: no caso adversarial
  // (projecto sem UI a quem se pede UI), 2 falhas em 15 corridas contra 0 em
  // 10 no braço que as tinha — sempre o mesmo modo, página sem ramo de lista
  // vazia. A versão CURTA da linha de base vai no lembrete final e está
  // provada presente (teste em contextBuilder.test.ts); não chegou.
  //
  // A diferença face às secções abaixo é o que elas SÃO. Estas carregam a
  // doutrina de GERAÇÃO, que se aplica no momento em que a UI nasce — e um
  // projecto sem UI é precisamente o que está a um pedido de ter a primeira.
  // As de baixo são PONTEIROS para ficheiros ("localiza src/theme/**"): num
  // projecto sem tema apontam para o vazio, e aí reter é ganho puro.
  // Regra 1 aplicada POR SINAL, não só ao projecto. Sem lista de dependências
  // (sem `package.json`, JSON inválido a meio de uma edição, Deno/Fresh, ou a
  // pasta aberta abaixo do manifesto do monorepo) os sinais que dependem dela
  // não dizem "não tem" — dizem "não sei". Reter com base em "não sei" era
  // exactamente a degradação silenciosa que este portão promete não fazer
  // (auditoria 06-08): um projecto React+Chakra a sério ficava sem as quatro
  // secções por causa de uma vírgula a mais no `package.json`.
  if (!evidence.hasThemeSurface && !evidence.depsUnknown) {
    const why = 'no theme/design-token surface in this project (no theme file, no tailwind config, no design-system dependency)'
    out.push({ id: 'design_system.semantic_tokens', reason: why })
    out.push({ id: 'design_system.theme_config', reason: why })
    out.push({ id: 'design_system.brand_palette', reason: why })
  }
  if (!evidence.hasChakra && !evidence.depsUnknown) {
    out.push({
      id: 'design_system.chakra_recipes',
      reason: 'Chakra UI is not a dependency of this project',
    })
  }
  if (!sessionHasImage) {
    out.push({
      id: 'vision.image_rules',
      reason: 'no image in this session yet (returns automatically on the turn an image arrives)',
    })
  }

  return out
}
