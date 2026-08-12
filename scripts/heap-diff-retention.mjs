/**
 * Quanto é que os diffs resolvidos retêm — medido no HEAP, não por RSS.
 *
 * PORQUE NÃO RSS: a primeira tentativa mediu o WebContent de um run headless
 * com um ficheiro de 450 KB. Cresceu 1,2 GB — e nada disso eram os diffs: um
 * ficheiro desses são ~112K tokens, portanto a LEITURA domina e afoga o sinal.
 * O RSS do WebContent mistura o allocator do WebKit, os modelos do Monaco, os
 * buffers de tool results e o highlighting. Para isolar a variável é preciso
 * medir o que o mecanismo realmente faz: reter strings no store.
 *
 * O que isto compara, com o MESMO número de diffs dos dois lados:
 *   RETIDO   — como era antes do fix: o tool call fica com as duas cópias
 *   LIBERTO  — como fica agora: `releaseResolvedDiff` apaga-as acima de 200 KB
 *
 *     node --expose-gc scripts/heap-diff-retention.mjs [n_diffs] [kb_por_lado]
 */
const N = Number(process.argv[2] ?? 40)
const KB = Number(process.argv[3] ?? 110)

if (typeof globalThis.gc !== 'function') {
  console.error('Correr com --expose-gc:  node --expose-gc scripts/heap-diff-retention.mjs')
  process.exit(1)
}

const MAX_RETAINED_DIFF_CHARS = 200_000

/** Cópia fiel do releaseResolvedDiff do chatStore (mesma regra, mesmo tecto). */
function releaseResolvedDiff(tc) {
  const size = (tc.diffOldContent?.length ?? 0) + (tc.diffNewContent?.length ?? 0)
  if (size <= MAX_RETAINED_DIFF_CHARS) return tc
  const next = { ...tc }
  delete next.diffOldContent
  delete next.diffNewContent
  return next
}

function estavel() {
  // Três passagens: a primeira liberta o lixo óbvio, as seguintes apanham o
  // que só fica elegível depois de a primeira correr.
  for (let i = 0; i < 3; i++) globalThis.gc()
  return process.memoryUsage().heapUsed
}

/**
 * Conteúdo REALISTA — linhas de código, não `'x'.repeat(n)`.
 *
 * A primeira versão usava `repeat` e mediu **0,1 MB para 8,6 MB de conteúdo**:
 * o V8 tem representação compacta para uma string de um só caracter repetido,
 * portanto ela não custa heap nenhum e o teste dava zero dos DOIS lados —
 * verde a dizer que não há fuga porque não há sequer memória. Verificado ao
 * lado: 4,5M chars por `repeat` = 0,02 MB; os mesmos 4,5M chars construídos
 * linha a linha = 21,6 MB.
 *
 * Linhas únicas por diff também importam: conteúdo idêntico entre diffs
 * arriscava partilha de strings e voltava a medir menos do que a realidade.
 */
function conteudo(i, lado) {
  const modelo = `export const ${lado.toUpperCase()}_${i}_X = "preenchimento com forma de codigo fonte";`
  const n = Math.ceil((KB * 1024) / (modelo.length + 12))
  return Array.from({ length: n }, (_, k) => `${modelo} // ${i}-${k}`).join('\n')
}

function corre(libertar) {
  const base = estavel()
  const sessao = []
  for (let i = 0; i < N; i++) {
    let tc = {
      id: `tc${i}`,
      toolName: 'Edit',
      status: 'completed',
      diffStatus: 'pending',
      diffOldContent: conteudo(i, 'old'),
      diffNewContent: conteudo(i, 'new'),
    }
    // Resolução: aprovado. Com o fix, passa pelo release.
    tc = libertar
      ? releaseResolvedDiff({ ...tc, diffStatus: 'approved' })
      : { ...tc, diffStatus: 'approved' }
    sessao.push(tc)
  }
  const depois = estavel()
  // `sessao` tem de continuar VIVO até à medição, senão mede-se zero nos dois.
  if (sessao.length !== N) throw new Error('impossível')
  return { retidoMB: (depois - base) / 1024 / 1024, sessao }
}

const teorico = (N * KB * 2) / 1024

console.log(`${N} diffs · ${KB} KB por lado · ${(KB * 2)} KB combinados (tecto do release: 200 KB)`)
console.log(`conteúdo total gerado: ${teorico.toFixed(1)} MB\n`)

const a = corre(false)
console.log(`RETIDO  (antes do fix) : ${a.retidoMB.toFixed(1)} MB`)
a.sessao.length = 0

const b = corre(true)
console.log(`LIBERTO (com o fix)    : ${b.retidoMB.toFixed(1)} MB`)
b.sessao.length = 0

const poupanca = a.retidoMB - b.retidoMB
console.log(`\npoupança: ${poupanca.toFixed(1)} MB em ${N} diffs  →  ${(poupanca / N).toFixed(2)} MB por diff`)
console.log(`um run com 20 edições grandes retinha ~${(poupanca / N * 20).toFixed(0)} MB que nunca desciam`)
