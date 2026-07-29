/**
 * Resíduo do read-dedup: só o marcador histórico sobrevive aqui.
 *
 * Este módulo ERA a supressão de releituras — quando o modelo chamava read_file
 * num intervalo que já tinha lido, com o ficheiro inalterado, recebia um stub
 * em vez do conteúdo. Foi REMOVIDA em 2026-07-29 por paridade com o claude-vaz
 * (cujo Read devolve sempre o que foi pedido, todas as vezes) e por causa
 * medida: na sessão katondo-queue foram 175 read_file em 127 turnos, 12,36M
 * tokens de input e a tarefa por acabar. A narração do modelo explica o ciclo —
 * "os resultados do Read estão a ser compactados", "vou ler em pequenas janelas
 * para evitar compactação", "tenho andado em círculos". O stub afirmava que o
 * conteúdo ainda estava na conversa quando, do ponto de vista do modelo, já não
 * estava; sem forma de obter o ficheiro, ele contornava pedindo janelas cada vez
 * menores, e cada contorno acrescentava contexto. A economia gastou 12 milhões
 * de tokens.
 *
 * O que fica é a CONSTANTE, e por uma razão de compatibilidade de dados, não de
 * comportamento — ver a nota nela.
 */

// ── Stub message ────────────────────────────────────────────────────────

/**
 * MARCADOR HISTÓRICO — já não é produzido. Não editar o texto.
 *
 * Isto ERA a resposta a uma releitura do mesmo intervalo com o ficheiro
 * inalterado. A supressão de releituras foi REMOVIDA em 2026-07-29 (paridade
 * com o claude-vaz, cujo Read devolve sempre o que foi pedido): a sessão
 * katondo-queue mostrou o custo real — 175 read_file em 127 turnos, 12,36M
 * tokens de input, tarefa por acabar, porque o stub afirmava que o conteúdo
 * ainda estava na conversa quando, do ponto de vista do modelo, já não estava,
 * e a saída documentada (`force: true`) era desaconselhada pela própria
 * descrição da tool. O parâmetro `force` também já não existe no schema —
 * portanto a última frase deste texto instrui algo IMPOSSÍVEL.
 *
 * A constante fica por uma razão só: as sessões PERSISTIDAS em disco contêm
 * este texto, e `readStateRecovery` compara-o com `startsWith` para saltar
 * esses tool_results ao reconstruir o estado de leitura. Mudar uma vírgula
 * quebra esse reconhecimento e a recuperação passa a tratar o stub como
 * conteúdo de ficheiro. É por isso que a frase morta continua aqui: ela é
 * DADOS de sessões antigas, não uma instrução que alguém vá receber.
 */
export const FILE_UNCHANGED_STUB =
  'File unchanged since last Read. The content you previously read is still current in the conversation/cache; use that existing knowledge rather than requesting it again. Do not work around this with execute_command/cat/head/tail/sed. If you need different lines, call Read only for the missing range. If compaction removed the exact text from context and you truly need the same range again, call Read once with force: true.'

// ── (Removido 2026-07-29) checkReadDedup ────────────────────────────────
//
// Decidia se uma releitura do MESMO intervalo, com o ficheiro inalterado, era
// servida com o FILE_UNCHANGED_STUB acima. Saiu com o resto da supressão de
// releituras, e ficara aqui sem chamadores. O que resta neste módulo é a
// constante — dados de sessões antigas em disco, ver a nota nela.
