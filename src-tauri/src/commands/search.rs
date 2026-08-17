use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::{canonicalize_path, normalize_str_for_frontend};

// ── Porque é que a busca deixou de correr o `rg` como processo (2026-07-28) ──
//
// Corria-se `rg` e, se o binário não respondesse, caía-se em `grep` (ou
// `findstr` no Windows). O fallback era silencioso e mudava a SEMÂNTICA: o
// `grep` não conhece .gitignore. Em qualquer máquina sem ripgrep instalado —
// e o ripgrep não é dependência de nada, portanto muitas — toda a busca do
// agente passava a devolver output de build. Foi o que aconteceu no
// momenu-fact: o primeiro Grep devolveu `functions/lib/*.js` (transpilado,
// gitignored) e o modelo construiu a tarefa toda em cima disso, acabando a
// propor apagar artefactos que o git não consegue restaurar. Ao mesmo tempo o
// Glob — que usa o `ignore` — filtrava-os. Duas tools, a mesma árvore, duas
// verdades.
//
// Embrulhar o executável do ripgrep como sidecar resolvia a falta do binário,
// mas mantinha o processo externo, o parse de JSON, a sonda que pode falhar e
// um Mach-O por plataforma para assinar/notarizar. As crates abaixo SÃO o
// ripgrep por dentro (`grep-searcher` + `grep-regex`), e o `ignore` — o walk
// com .gitignore — já cá estava para o Glob. Linkar as duas metades apaga a
// classe de bug em vez de a tornar menos provável: não há binário para
// faltar, nem caminho degradado para onde cair.

/// Ruído excluído de todas as buscas, independentemente do .gitignore.
/// NÃO inclui nomes de pastas de build (`lib/`, `out/`): há projectos que
/// guardam fonte real nesses caminhos. Quem declara o que é derivado é o
/// .gitignore do próprio projecto, não uma lista de nomes nossa.
const BUILTIN_EXCLUDES: &[&str] = &[
    "!node_modules/**",
    "!*.min.js",
    "!*.min.css",
    "!*.map",
    "!package-lock.json",
    "!yarn.lock",
    "!pnpm-lock.yaml",
    "!*.tsbuildinfo",
];

/// Ficheiros acima disto não são procurados (paridade com `--max-filesize 1M`).
const MAX_SEARCH_FILESIZE: u64 = 1024 * 1024;

fn build_matcher(query: &str, options: &SearchOptions) -> Result<RegexMatcher, String> {
    let pattern = if options.use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .word(options.whole_word)
        .build(&pattern)
        .map_err(|e| format!("Invalid search pattern: {}", e))
}

/// Os `include_patterns` só ESTREITAM a busca — nunca destrancam o que o
/// .gitignore esconde.
///
/// Não podem ir para o `OverrideBuilder` com os excludes: lá são globs de
/// whitelist, e no `ignore` um acerto de whitelist curto-circuita os matchers
/// de .gitignore. `includePatterns: ["*.js"]` num projecto com `lib/` ignorado
/// devolvia o transpilado sem ninguém o ter pedido (sessão momenu-fact 23:08)
/// — a mesma falha do incidente original por outra porta, e pior, porque o
/// schema promete ao modelo que `includeIgnored` é a ÚNICA forma de lá chegar.
///
/// Devolve `None` quando não há padrões (tudo passa). Semântica de gitignore:
/// `*` atravessa `/`, logo `*.ts` apanha a qualquer profundidade.
fn build_include_set(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    let mut builder = GlobSetBuilder::new();
    let mut any = false;
    for pattern in patterns {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            continue;
        }
        builder.add(
            Glob::new(pattern)
                .map_err(|e| format!("Invalid include pattern '{}': {}", pattern, e))?,
        );
        any = true;
    }
    if !any {
        return Ok(None);
    }
    builder
        .build()
        .map(Some)
        .map_err(|e| format!("Failed to build include filters: {}", e))
}

/// Walk com as mesmas regras do Glob (`glob_files_filtered`), para que as duas
/// tools nunca descrevam a mesma árvore de maneiras diferentes.
fn build_walker(root: &Path, options: &SearchOptions) -> Result<ignore::Walk, String> {
    // `respect_gitignore` por omissão LIGADO: descoberta honesta é o default.
    // Desligá-lo continua possível (depurar um build partido, ler o que
    // compilou) — é o mesmo opt-in do Glob, não um caminho acidental.
    let respect = options.respect_gitignore.unwrap_or(true);

    let mut overrides = OverrideBuilder::new(root);
    let mut add = |glob: &str| -> Result<(), String> {
        overrides
            .add(glob)
            .map(|_| ())
            .map_err(|e| format!("Invalid glob pattern '{}': {}", glob, e))
    };
    // Só EXCLUSÕES aqui — ver build_include_set para o porquê.
    for pattern in &options.exclude_patterns {
        if !pattern.trim().is_empty() {
            add(&format!("!{}", pattern))?;
        }
    }
    // `node_modules` é o único do lote que o `includeIgnored` tem de poder
    // alcançar: a descrição do Grep nomeia "ler o código real de uma
    // dependência" como caso de uso, e com esta exclusão incondicional isso
    // devolvia sempre vazio. Os restantes (minificados, sourcemaps, lockfiles)
    // são ruído em qualquer cenário, incluindo o de depurar um build.
    for exclude in BUILTIN_EXCLUDES {
        if !respect && *exclude == "!node_modules/**" {
            continue;
        }
        add(exclude)?;
    }
    let overrides = overrides
        .build()
        .map_err(|e| format!("Failed to build search filters: {}", e))?;

    // Ler .gitignore de directórios ACIMA da raiz da busca só faz sentido
    // quando a raiz está mesmo dentro de um repositório — aí as regras do topo
    // do repo aplicam-se de facto. Fora de um repo, `parents` faria um
    // `~/dev/.gitignore` esquecido filtrar em silêncio todos os projectos por
    // baixo: exactamente o tipo de exclusão invisível que esta série anda a
    // eliminar. Dentro do projecto os .gitignore aninhados são lidos pelo
    // próprio walk, portanto não se perde nada.
    let in_git_repo = root.ancestors().any(|a| a.join(".git").exists());

    let mut builder = WalkBuilder::new(root);
    builder
        // Dot-FICHEIROS são procuráveis (.eslintrc, .env.example); os `.env`
        // selados saem no strip_sealed_env_files, que é a barreira certa.
        .hidden(false)
        .git_ignore(respect)
        .git_global(respect)
        .git_exclude(respect)
        .ignore(respect)
        .parents(respect && in_git_repo)
        // Sem isto o WalkBuilder só honra .gitignore DENTRO de um repositório
        // git, e o Glob (que usa matchers Gitignore directos) honra-o sempre —
        // as duas tools voltariam a divergir num projecto ainda sem `git init`.
        .require_git(false)
        // `max_filesize` SAIU daqui de propósito (auditoria 2026-07-29): o
        // walker descartava ficheiros >1MB dentro do iterador, sem deixar
        // rasto. Uma busca por um símbolo que vive num ficheiro grande — um
        // bundle, um dump SQL, um schema gerado — respondia "No matches found"
        // e o modelo concluía que o símbolo não existe. O corte continua (é
        // paridade com `--max-filesize 1M` e protege o tempo de resposta), mas
        // agora é feito no laço, onde pode ser CONTADO e reportado.
        .overrides(overrides)
        // Poda dot-DIRECTÓRIOS (.git, .next, .yarn) na descida, em vez de
        // descer e descartar ficheiro a ficheiro. A raiz nunca é podada: uma
        // busca dentro de ~/.config tem de continuar a funcionar.
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                return !entry.file_name().to_string_lossy().starts_with('.');
            }
            true
        });
    Ok(builder.build())
}

/// Quanto é que a busca precisa de recolher.
///
/// O `replace_in_files` só quer saber QUE ficheiros contêm o padrão — o
/// `--files-with-matches` do rg era exactamente isto. Sem o modo, um
/// "substituir em todo o projecto" carregava o texto de cada acerto para
/// o deitar fora a seguir.
#[derive(Clone, Copy, PartialEq)]
enum SearchDepth {
    /// Linhas, colunas e texto do match (a busca que a UI e o agente mostram).
    Content,
    /// Só o primeiro acerto por ficheiro; nada é guardado.
    PathsOnly,
    /// CONTA todos os acertos de cada ficheiro, sem guardar texto nenhum.
    /// Mais barato que o modo Content quando só interessa o total.
    CountOnly,
}

/// Recolhe os matches de UM ficheiro, com tecto global (sem tecto por ficheiro).
struct MatchSink<'a> {
    matcher: &'a RegexMatcher,
    matches: Vec<SearchMatch>,
    remaining_global: usize,
    depth: SearchDepth,
    /// Em PathsOnly não há `matches` para contar — este flag é o resultado.
    matched_any: bool,
    /// Acertos contados em CountOnly (sem tecto, sem texto guardado).
    counted: usize,
    /// A leitura deste ficheiro parou porque o `head_limit` global esgotou
    /// a meio — não porque haja um tecto por ficheiro.
    capped: bool,
}

impl Sink for MatchSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.depth == SearchDepth::PathsOnly {
            self.matched_any = true;
            return Ok(false); // um acerto basta; não se lê o resto do ficheiro
        }
        if self.depth == SearchDepth::CountOnly {
            self.counted += 1;
            self.matched_any = true;
            return Ok(true); // continua: o objectivo é o total real
        }
        // Sem tecto por ficheiro (paridade Grep do cli-vaz). O único corte
        // em modo content é o `head_limit` global (`remaining_global`).
        if self.remaining_global == 0 {
            self.capped = true;
            return Ok(false);
        }
        let bytes = mat.bytes();
        let line_raw = String::from_utf8_lossy(bytes);
        let line_text = line_raw.trim_end_matches(['\n', '\r']);

        // Coluna 0-based e texto do match, como o `--json` do rg os dava.
        let (column, match_text) = match self.matcher.find(bytes) {
            Ok(Some(m)) => (
                m.start() as u32,
                String::from_utf8_lossy(&bytes[m.start()..m.end()]).to_string(),
            ),
            _ => (0, String::new()),
        };

        self.matches.push(SearchMatch {
            line_number: mat.line_number().unwrap_or(0) as u32,
            column,
            text: truncate_search_line(line_text),
            match_text,
            context_before: vec![],
            context_after: vec![],
        });
        self.remaining_global -= 1;
        Ok(true)
    }
}

/// Percorre a árvore e procura, em processo. Devolve
/// `(ficheiros, total_matches, truncated)`.
fn run_search(
    query: &str,
    root: &Path,
    options: &SearchOptions,
    global_limit: usize,
) -> Result<(Vec<FileSearchResult>, usize, bool, usize), String> {
    let depth = if options.count_only {
        SearchDepth::CountOnly
    } else {
        SearchDepth::Content
    };
    run_search_with_depth(query, root, options, global_limit, depth)
}

/// Devolve `(ficheiros, total_matches, truncated, saltados_por_tamanho)`.
fn run_search_with_depth(
    query: &str,
    root: &Path,
    options: &SearchOptions,
    global_limit: usize,
    depth: SearchDepth,
) -> Result<(Vec<FileSearchResult>, usize, bool, usize), String> {
    let matcher = build_matcher(query, options)?;
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        // Números de linha custam uma contagem por ficheiro e o modo
        // PathsOnly não os usa.
        .line_number(depth == SearchDepth::Content)
        .build();

    let mut files: Vec<FileSearchResult> = vec![];
    let mut total_matches = 0usize;
    let mut truncated = false;
    let mut skipped_too_large = 0usize;

    // Um ficheiro como alvo é dialecto do Grep do Claude Code ("procurar só
    // neste ficheiro") e é pedido explícito — procura-se sem walk nem filtro.
    let entries: Vec<PathBuf> = if root.is_file() {
        vec![root.to_path_buf()]
    } else {
        let includes = build_include_set(&options.include_patterns)?;
        build_walker(root, options)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_some_and(|ft| ft.is_file()))
            .map(|entry| entry.into_path())
            .filter(|path| match &includes {
                // Testado contra o caminho RELATIVO à raiz, como o .gitignore
                // faz — senão `src/**` compararia contra o caminho absoluto da
                // máquina e nunca acertava.
                Some(set) => set.is_match(path.strip_prefix(root).unwrap_or(path)),
                None => true,
            })
            .collect()
    };

    for path in entries {
        if total_matches >= global_limit {
            truncated = true;
            break;
        }
        // Corte por tamanho, agora explícito e contado. Um `metadata()` que
        // falha (ficheiro apagado a meio do walk, permissões) não conta como
        // "grande" — segue para a busca, que trata o erro dela.
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_SEARCH_FILESIZE) {
            skipped_too_large += 1;
            continue;
        }
        let mut sink = MatchSink {
            matcher: &matcher,
            matches: vec![],
            remaining_global: global_limit - total_matches,
            depth,
            matched_any: false,
            counted: 0,
            capped: false,
        };
        // Um ficheiro ilegível (permissões, apagado a meio do walk, UTF-16
        // inválido) não pode abortar a busca inteira — salta-se.
        if searcher.search_path(&matcher, &path, &mut sink).is_err() {
            continue;
        }
        if !sink.matched_any && sink.matches.is_empty() {
            continue;
        }
        let hits = if depth == SearchDepth::CountOnly {
            sink.counted
        } else {
            sink.matches.len().max(usize::from(sink.matched_any))
        };
        total_matches += hits;
        files.push(FileSearchResult {
            file_path: normalize_str_for_frontend(&path.to_string_lossy()),
            total_matches: hits,
            capped_at_file_limit: sink.capped,
            matches: sink.matches,
        });
        // Cortar a meio do ficheiro significa que ainda havia acertos — o
        // `truncated` tem de o dizer mesmo quando este era o último da lista.
        if sink.capped {
            truncated = true;
            break;
        }
    }

    Ok((files, total_matches, truncated, skipped_too_large))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub use_regex: bool,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub max_results: Option<usize>,
    pub context_lines: Option<usize>,
    /// Drop matches inside sealed `.env` files. Set by the AGENT's search tool;
    /// the human's own Search panel leaves it off — sealing exists to keep
    /// secrets out of the model's context, not out of the developer's editor.
    #[serde(default)]
    pub seal_env_files: bool,
    /// Respeitar .gitignore. `None` = sim (o default honesto). Espelha o
    /// `includeIgnored` do Glob, para as duas tools terem o mesmo opt-out em
    /// vez de regras diferentes sobre a mesma árvore.
    #[serde(default)]
    pub respect_gitignore: Option<bool>,
    /// Só contar: totais por ficheiro sem tecto e sem texto de linha.
    /// Ligado pelo `outputMode: "count"` do agente — ver SearchDepth::CountOnly.
    #[serde(default)]
    pub count_only: bool,
}

/// Env TEMPLATE basenames — documentation, never secrets.
/// Mirrors `ENV_TEMPLATE_FILES` in src/services/agent/toolExecutor/checks.ts.
const ENV_TEMPLATE_FILES: &[&str] = &[".env.example", ".env.sample", ".env.template", ".env.dist"];

/// True for a sealed env file (`.env`, `.env.local`, `.env.production`, …),
/// false for the documented templates.
fn is_sealed_env_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or("");
    if !name.starts_with(".env") {
        return false;
    }
    !ENV_TEMPLATE_FILES.contains(&name)
}

/// Strip every hit that lives inside a sealed `.env` file.
///
/// Why at the SOURCE and not only in the frontend gate (auditoria 2026-07-28):
/// the executor's `.env` seal only covered read/write/edit/delete, while search
/// is auto-approved as a SAFE tool AND ripgrep here runs with `--hidden` while
/// globbing out dot-DIRECTORIES only. So a plain
/// `search_files(query: ".", directory: ".")` streamed the entire secret file
/// into the model's context with no dialog. Filtering here means no backend
/// (rg / grep / findstr) can leak secrets regardless of the arguments chosen.
fn strip_sealed_env_files(result: &mut SearchResult) {
    let before = result.files.len();
    result.files.retain(|f| !is_sealed_env_file(&f.file_path));
    if result.files.len() != before {
        result.total_files = result.files.len();
        result.total_matches = result.files.iter().map(|f| f.total_matches).sum();
    }
    result
        .file_name_matches
        .retain(|m| !is_sealed_env_file(&m.file_path));
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchMatch {
    pub line_number: u32,
    pub column: u32,
    pub text: String,
    pub match_text: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileSearchResult {
    pub file_path: String,
    pub matches: Vec<SearchMatch>,
    /// Acertos DEVOLVIDOS, não acertos existentes. Ver `capped_at_file_limit`.
    pub total_matches: usize,
    /// `true` quando a leitura parou porque o tecto GLOBAL esgotou a meio
    /// deste ficheiro — há mais acertos
    /// neste ficheiro que ninguém contou. Quem formata tem de o dizer.
    #[serde(default)]
    pub capped_at_file_limit: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileNameMatch {
    pub file_path: String,
    pub file_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub query: String,
    pub total_files: usize,
    pub total_matches: usize,
    pub files: Vec<FileSearchResult>,
    /// Files whose name contains the query (file-name search, not content)
    pub file_name_matches: Vec<FileNameMatch>,
    pub duration_ms: u64,
    pub truncated: bool,
    /// Ficheiros que existiam e casavam com os filtros mas não foram
    /// procurados por passarem de MAX_SEARCH_FILESIZE.
    ///
    /// O corte existia; o SILÊNCIO era o defeito (auditoria 2026-07-29). Uma
    /// busca por um símbolo que vive num ficheiro grande — um bundle, um dump
    /// SQL, um schema gerado — respondia "No matches found" e o modelo concluía
    /// que o símbolo não existe.
    #[serde(default)]
    pub skipped_too_large: usize,
}

/// Tecto quando `max_results` não vem (UI / replace). O agente envia sempre
/// um número: default 250, `0` = sem tecto (`resolve_global_limit`).
const GLOBAL_MAX_MATCHES: usize = 500;

fn resolve_global_limit(max_results: Option<usize>) -> usize {
    match max_results {
        Some(0) => usize::MAX,
        Some(m) => m,
        None => GLOBAL_MAX_MATCHES,
    }
}
/// Max line length sent to frontend (longer lines are truncated).
const MAX_LINE_LENGTH: usize = 500;
/// Max before/after context lines per match. Keeps agent/UI payloads bounded.
const MAX_CONTEXT_LINES: usize = 10;

fn truncate_search_line(text_raw: &str) -> String {
    if text_raw.len() > MAX_LINE_LENGTH {
        match text_raw.char_indices().nth(MAX_LINE_LENGTH) {
            Some((byte_idx, _)) => format!("{}…", &text_raw[..byte_idx]),
            None => text_raw.to_string(),
        }
    } else {
        text_raw.to_string()
    }
}

fn requested_context_lines(options: &SearchOptions) -> usize {
    options.context_lines.unwrap_or(0).min(MAX_CONTEXT_LINES)
}

fn attach_match_context(files: &mut [FileSearchResult], context_lines: usize) {
    if context_lines == 0 {
        return;
    }

    for file in files {
        let Ok(content) = std::fs::read_to_string(&file.file_path) else {
            continue;
        };
        let lines: Vec<&str> = content.lines().collect();
        if lines.is_empty() {
            continue;
        }

        for m in &mut file.matches {
            if m.line_number == 0 {
                continue;
            }
            let line_index = (m.line_number - 1) as usize;
            if line_index >= lines.len() {
                continue;
            }

            let before_start = line_index.saturating_sub(context_lines);
            m.context_before = lines[before_start..line_index]
                .iter()
                .map(|line| truncate_search_line(line))
                .collect();

            let after_start = line_index.saturating_add(1);
            let after_end = (after_start + context_lines).min(lines.len());
            m.context_after = if after_start < after_end {
                lines[after_start..after_end]
                    .iter()
                    .map(|line| truncate_search_line(line))
                    .collect()
            } else {
                vec![]
            };
        }
    }
}

#[tauri::command]
pub async fn search_in_files(
    query: String,
    directory: String,
    options: SearchOptions,
) -> Result<SearchResult, String> {
    let start_time = std::time::Instant::now();

    if query.trim().is_empty() {
        return Ok(SearchResult {
            query,
            total_files: 0,
            total_matches: 0,
            files: vec![],
            file_name_matches: vec![],
            duration_ms: 0,
            truncated: false,
            skipped_too_large: 0,
        });
    }

    let directory_path = PathBuf::from(&directory);
    // Aceita diretório OU ficheiro: os modelos falam o dialeto do Grep do
    // Claude Code (o `path` de lá aceita ambos) e passam frequentemente um
    // ficheiro para "procurar só neste ficheiro" — o rg e o grep aceitam
    // um ficheiro como alvo nativamente, portanto rejeitar era uma
    // restrição artificial (erro visto em produção 2026-06-12 com
    // search(release-station) sobre .../routes/users.ts). O findstr do
    // Windows trata o caso ficheiro no próprio call-site.
    // A mensagem tem de dizer a causa REAL. Esta guarda só testa existência
    // (ficheiro é alvo válido, ver acima), mas dizia "does not exist or is not
    // a directory" — e o modelo, ao ler isso depois de passar um ficheiro,
    // concluía que o problema era o TIPO do caminho e reformulava a busca em
    // vez de corrigir o caminho errado (sessão 05-08, patients.ts inexistente).
    if !directory_path.exists() {
        return Err(format!(
            "Path does not exist: {}. Note: this parameter accepts a directory OR a single file — \
             the error is the path itself, not its type. Check the path (LS/Glob) and retry.",
            directory
        ));
    }

    let directory_path = canonicalize_path(&directory_path)
        .map_err(|e| format!("Failed to resolve directory path: {}", e))?;

    // Security: reject search outside the user's home directory to prevent
    // path traversal attacks (e.g. searching /etc/passwd via the agent).
    // canonicalize_path strips the Windows UNC \\?\ prefix so prefix matching
    // works consistently across platforms.
    if let Some(home) = dirs::home_dir() {
        let canonical_home = canonicalize_path(&home).unwrap_or(home);
        if !directory_path.starts_with(&canonical_home) {
            return Err(format!(
                "Search directory must be within home directory: {}",
                directory_path.display()
            ));
        }
    }

    // `max_results: 0` = sem tecto (paridade cli-vaz `head_limit=0`).
    // Sem valor = o tecto de segurança da UI (500). O agente envia sempre
    // um número (default 250).
    let global_limit = resolve_global_limit(options.max_results);

    // O walk e a leitura são bloqueantes (I/O + CPU): fora da thread do
    // runtime, para não travar os outros comandos durante uma busca grande.
    let query_for_search = query.clone();
    let root = directory_path.clone();
    let context_lines = requested_context_lines(&options);
    let seal_env_files = options.seal_env_files;
    let max_results = options.max_results;

    let (mut files, total_matches, mut truncated, skipped_too_large) =
        tokio::task::spawn_blocking(move || {
            run_search(&query_for_search, &root, &options, global_limit)
        })
        .await
        .map_err(|e| format!("Search task failed: {}", e))??;

    attach_match_context(&mut files, context_lines);

    if !truncated {
        if let Some(max) = max_results {
            if max > 0 && total_matches >= max {
                truncated = true;
            }
        }
    }

    // Sort: files whose basename contains the query come first,
    // then by path alphabetically. This ensures "index.ts" appears
    // near the top when searching for "index".
    let query_lower = query.to_lowercase();
    files.sort_by(|a, b| {
        let a_name = std::path::Path::new(&a.file_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| a.file_path.to_lowercase());
        let b_name = std::path::Path::new(&b.file_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| b.file_path.to_lowercase());
        let a_in_name = a_name.contains(&query_lower);
        let b_in_name = b_name.contains(&query_lower);
        match (a_in_name, b_in_name) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_path.cmp(&b.file_path),
        }
    });

    let duration = start_time.elapsed();

    let mut result = SearchResult {
        query,
        total_files: files.len(),
        total_matches,
        files,
        file_name_matches: vec![],
        duration_ms: duration.as_millis() as u64,
        truncated,
        skipped_too_large,
    };
    if seal_env_files {
        strip_sealed_env_files(&mut result);
    }
    Ok(result)
}

#[tauri::command]
pub async fn replace_in_files(
    query: String,
    replacement: String,
    directory: String,
    options: SearchOptions,
) -> Result<u32, String> {
    if query.trim().is_empty() {
        return Err("Search query cannot be empty".to_string());
    }

    // Aqui a exigência de diretório é real (substituição em massa varre uma
    // árvore), por isso os dois casos separam-se para a mensagem não mentir.
    let directory_path = PathBuf::from(&directory);
    if !directory_path.exists() {
        return Err(format!("Path does not exist: {}", directory));
    }
    if !directory_path.is_dir() {
        return Err(format!(
            "Replace-in-files needs a directory, but this path is a file: {}",
            directory
        ));
    }

    let directory_path = canonicalize_path(&directory_path)
        .map_err(|e| format!("Failed to resolve directory path: {}", e))?;

    // Mesma descoberta que a busca: os ficheiros a substituir são os que a
    // busca mostrou. Se divergissem, o "substituir em todos" atingia ficheiros
    // que o utilizador nunca viu nos resultados.
    let query_for_search = query.clone();
    let root = directory_path.clone();
    let search_options = SearchOptions {
        case_sensitive: options.case_sensitive,
        whole_word: options.whole_word,
        use_regex: options.use_regex,
        include_patterns: options.include_patterns.clone(),
        exclude_patterns: options.exclude_patterns.clone(),
        max_results: None,
        context_lines: None,
        seal_env_files: options.seal_env_files,
        respect_gitignore: options.respect_gitignore,
        // O replace precisa dos CAMINHOS (PathsOnly a seguir), nunca de contagens.
        count_only: false,
    };
    let (matched_files, _, _, _) = tokio::task::spawn_blocking(move || {
        run_search_with_depth(
            &query_for_search,
            &root,
            &search_options,
            usize::MAX,
            SearchDepth::PathsOnly,
        )
    })
    .await
    .map_err(|e| format!("Replace search task failed: {}", e))??;

    let files: Vec<String> = matched_files
        .into_iter()
        .filter(|f| !options.seal_env_files || !is_sealed_env_file(&f.file_path))
        .map(|f| f.file_path)
        .collect();
    if files.is_empty() {
        return Ok(0);
    }
    let mut affected_count: u32 = 0;

    let regex = if options.use_regex {
        if options.case_sensitive {
            regex::Regex::new(&query)
        } else {
            regex::Regex::new(&format!("(?i){}", query))
        }
    } else {
        let escaped = regex::escape(&query);
        let pattern = if options.whole_word {
            format!(r"\b{}\b", escaped)
        } else {
            escaped
        };
        if options.case_sensitive {
            regex::Regex::new(&pattern)
        } else {
            regex::Regex::new(&format!("(?i){}", pattern))
        }
    }
    .map_err(|e| format!("Invalid search pattern: {}", e))?;

    for file_path in &files {
        // Canonicalize to match directory_path (which is canonicalized).
        // canonicalize_path strips the Windows UNC \\?\ prefix.
        let path = canonicalize_path(std::path::Path::new(file_path))
            .unwrap_or_else(|_| PathBuf::from(file_path));
        if !path.starts_with(&directory_path) {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(content) => {
                let new_content = regex
                    .replace_all(&content, replacement.as_str())
                    .to_string();
                if new_content != content {
                    if let Err(e) = std::fs::write(&path, &new_content) {
                        eprintln!("Failed to write replacement to {}: {}", file_path, e);
                        continue;
                    }
                    affected_count += 1;
                }
            }
            Err(e) => {
                eprintln!("Failed to read {}: {}", file_path, e);
            }
        }
    }

    Ok(affected_count)
}

/// Mantido pelo frontend (`SearchService.checkRipgrepAvailable`), agora sempre
/// verdadeiro: o motor de busca é linkado, não um binário do sistema. Havia
/// aqui uma sonda que devolvia `false` nas máquinas sem ripgrep — e era esse
/// `false` que activava o fallback para `grep`, sem .gitignore. Já não há nada
/// que possa faltar, logo nada que possa degradar.
#[tauri::command]
pub async fn check_ripgrep_available() -> Result<bool, String> {
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(respect_gitignore: Option<bool>) -> SearchOptions {
        SearchOptions {
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            include_patterns: vec![],
            exclude_patterns: vec![],
            max_results: None,
            context_lines: None,
            seal_env_files: false,
            respect_gitignore,
            count_only: false,
        }
    }

    fn found_files(root: &Path, query: &str, respect_gitignore: Option<bool>) -> Vec<String> {
        let (files, _, _, _) =
            run_search(query, root, &opts(respect_gitignore), GLOBAL_MAX_MATCHES).unwrap();
        let mut names: Vec<String> = files
            .into_iter()
            .map(|f| {
                Path::new(&f.file_path)
                    .strip_prefix(root)
                    .unwrap_or_else(|_| Path::new(&f.file_path))
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        names.sort();
        names
    }

    /// Regressão momenu-fact (2026-07-28). O primeiro Grep da sessão devolveu
    /// `functions/lib/*.js` — output de `tsc`, declarado no .gitignore — e o
    /// modelo construiu a tarefa em cima do transpilado, acabando a propor
    /// apagar artefactos que o git não pode restaurar. A causa era o fallback
    /// silencioso para `grep` quando o binário `rg` não existia na máquina.
    /// Com o motor linkado não há binário que falte: o filtro é sempre o mesmo.
    #[test]
    fn gitignored_build_output_stays_out_of_search_results() {
        let dir = std::env::temp_dir().join(format!("tm_search_gi_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("functions/src")).unwrap();
        std::fs::create_dir_all(dir.join("functions/lib")).unwrap();

        std::fs::write(dir.join("functions/.gitignore"), "lib/**/*.js\n").unwrap();
        std::fs::write(
            dir.join("functions/src/seed.ts"),
            "export const seedPremiumTemplates = 1\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("functions/lib/seed.js"),
            "exports.seedPremiumTemplates = 1\n",
        )
        .unwrap();

        let root = canonicalize_path(&dir).unwrap();

        // Por omissão: só a FONTE. É o que um dev vê ao entrar no projecto.
        let default_hits = found_files(&root, "seedPremiumTemplates", None);
        assert_eq!(
            default_hits,
            vec!["functions/src/seed.ts".to_string()],
            "transpilado gitignored não pode aparecer na busca por omissão"
        );

        // Opt-in explícito: o transpilado É o assunto (depurar um build).
        let with_ignored = found_files(&root, "seedPremiumTemplates", Some(false));
        assert!(
            with_ignored.contains(&"functions/lib/seed.js".to_string()),
            "includeIgnored tem de continuar a alcançar o build output: {:?}",
            with_ignored
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `lib/` não é palavra proibida: há projectos que lá guardam fonte real.
    /// Quem declara o que é derivado é o .gitignore do projecto, não uma lista
    /// de nomes nossa — por isso `lib/` NÃO está em BUILTIN_EXCLUDES.
    #[test]
    fn lib_directory_is_visible_when_the_project_tracks_it() {
        let dir = std::env::temp_dir().join(format!("tm_search_lib_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        // Sem .gitignore: `lib/` é fonte, como em muitas bibliotecas.
        std::fs::write(dir.join("lib/index.js"), "export const marker = 1\n").unwrap();

        let root = canonicalize_path(&dir).unwrap();
        assert_eq!(
            found_files(&root, "marker", None),
            vec!["lib/index.js".to_string()],
            "lib/ não ignorado é fonte e tem de ser encontrado"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// O `.env` selado nunca chega ao modelo, venha de onde vier o match.
    #[test]
    fn sealed_env_files_are_stripped_from_results() {
        let dir = std::env::temp_dir().join(format!("tm_search_env_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env"), "SECRET_TOKEN=abc\n").unwrap();
        std::fs::write(dir.join(".env.example"), "SECRET_TOKEN=\n").unwrap();

        let root = canonicalize_path(&dir).unwrap();
        let (files, _, _, _) =
            run_search("SECRET_TOKEN", &root, &opts(None), GLOBAL_MAX_MATCHES).unwrap();
        let mut result = SearchResult {
            query: "SECRET_TOKEN".to_string(),
            total_files: files.len(),
            total_matches: files.iter().map(|f| f.total_matches).sum(),
            files,
            file_name_matches: vec![],
            duration_ms: 0,
            truncated: false,
            skipped_too_large: 0,
        };
        // Sem selo o `.env` é alcançável — é por isso que o selo existe.
        assert!(result.files.iter().any(|f| f.file_path.ends_with(".env")));

        strip_sealed_env_files(&mut result);
        assert!(
            !result.files.iter().any(|f| f.file_path.ends_with(".env")),
            "o .env selado tem de sair"
        );
        assert!(
            result
                .files
                .iter()
                .any(|f| f.file_path.ends_with(".env.example")),
            "o template documentado fica"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// O alias `Grep` traduz `type: "js"` e `glob:` para include_patterns, e o
    /// motor novo passou de globs do `rg` para `ignore::overrides` — semânticas
    /// parecidas mas não idênticas. Sem este teste, um include partido devolvia
    /// vazio e o modelo lia "não existe": a tool a mentir-lhe, que é o próprio
    /// bug que esta série de commits anda a fechar.
    #[test]
    fn include_and_exclude_patterns_still_filter_after_the_engine_swap() {
        let dir = std::env::temp_dir().join(format!("tm_inc_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/deep")).unwrap();
        std::fs::write(dir.join("src/a.ts"), "MARKER\n").unwrap();
        std::fs::write(dir.join("src/b.js"), "MARKER\n").unwrap();
        std::fs::write(dir.join("src/deep/c.ts"), "MARKER\n").unwrap();
        let root = canonicalize_path(&dir).unwrap();

        let mut o = opts(None);
        o.include_patterns = vec!["*.ts".to_string()];
        let (files, _, _, _) = run_search("MARKER", &root, &o, GLOBAL_MAX_MATCHES).unwrap();
        let mut got: Vec<String> = files
            .iter()
            .map(|f| f.file_path.replace(root.to_str().unwrap(), ""))
            .collect();
        got.sort();
        // `*.ts` sem barra apanha a QUALQUER profundidade (dialecto gitignore),
        // e os directórios continuam a ser descidos apesar do whitelist.
        assert_eq!(
            got,
            vec!["/src/a.ts".to_string(), "/src/deep/c.ts".to_string()]
        );

        let mut o2 = opts(None);
        o2.exclude_patterns = vec!["**/*.js".to_string()];
        let (files2, _, _, _) = run_search("MARKER", &root, &o2, GLOBAL_MAX_MATCHES).unwrap();
        let mut got2: Vec<String> = files2
            .iter()
            .map(|f| f.file_path.replace(root.to_str().unwrap(), ""))
            .collect();
        got2.sort();
        assert_eq!(
            got2,
            vec!["/src/a.ts".to_string(), "/src/deep/c.ts".to_string()]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Os include patterns ESTREITAM; nunca destrancam o que o .gitignore
    /// esconde.
    ///
    /// Regressão medida na sessão momenu-fact das 23:08: as buscas sem
    /// `includePatterns` filtravam bem, mas `includePatterns: ["*.js"]`
    /// devolvia `functions/lib/*.js` — transpilado que ninguém pediu. A causa
    /// era eu ter mandado os includes para o `OverrideBuilder` junto com os
    /// excludes: lá são globs de WHITELIST, e no `ignore` um acerto de
    /// whitelist curto-circuita os matchers de .gitignore. Passou a haver duas
    /// portas para o output de build quando o schema promete ao modelo que só
    /// existe uma (`includeIgnored`).
    #[test]
    fn include_patterns_never_unlock_gitignored_paths() {
        let dir = std::env::temp_dir().join(format!("tm_incgi_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join(".gitignore"), "lib/**/*.js\n").unwrap();
        std::fs::write(dir.join("src/a.ts"), "MARKER\n").unwrap();
        std::fs::write(dir.join("lib/a.js"), "MARKER\n").unwrap();
        let root = canonicalize_path(&dir).unwrap();

        let mut o = opts(None);
        o.include_patterns = vec!["*.js".to_string(), "*.ts".to_string()];
        let (files, _, _, _) = run_search("MARKER", &root, &o, GLOBAL_MAX_MATCHES).unwrap();
        let got: Vec<String> = files
            .iter()
            .map(|f| f.file_path.replace(root.to_str().unwrap(), ""))
            .collect();
        assert_eq!(
            got,
            vec!["/src/a.ts".to_string()],
            "pedir *.js nao pode destrancar o transpilado ignorado: {:?}",
            got
        );

        // A porta legítima continua aberta — e é a única.
        let mut o2 = opts(Some(false));
        o2.include_patterns = vec!["*.js".to_string()];
        let (files2, _, _, _) = run_search("MARKER", &root, &o2, GLOBAL_MAX_MATCHES).unwrap();
        assert!(
            files2.iter().any(|f| f.file_path.ends_with("lib/a.js")),
            "com includeIgnored o transpilado tem de continuar alcancavel"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `parents` lia .gitignore ACIMA da raiz mesmo fora de um repositório: um
    /// `~/dev/.gitignore` esquecido filtrava em silêncio todos os projectos por
    /// baixo — o mesmo tipo de exclusão invisível que esta série anda a
    /// eliminar. Sem `.git` por cima, só contam os .gitignore de dentro.
    #[test]
    fn gitignore_above_the_root_does_not_apply_outside_a_repo() {
        let base = std::env::temp_dir().join(format!("tm_parents_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("project");
        std::fs::create_dir_all(&project).unwrap();
        // Ancestral a ignorar *.ts, MAS sem repositório nenhum.
        std::fs::write(base.join(".gitignore"), "*.ts\n").unwrap();
        std::fs::write(project.join("a.ts"), "MARKER\n").unwrap();

        let root = canonicalize_path(&project).unwrap();
        let (files, _, _, _) =
            run_search("MARKER", &root, &opts(None), GLOBAL_MAX_MATCHES).unwrap();
        assert_eq!(
            files.len(),
            1,
            "regra de ancestral fora de repo nao pode filtrar"
        );

        // Com um repositório por cima, as regras do topo passam a valer — que
        // é o que o git faz.
        std::fs::create_dir_all(base.join(".git")).unwrap();
        let (files2, _, _, _) =
            run_search("MARKER", &root, &opts(None), GLOBAL_MAX_MATCHES).unwrap();
        assert_eq!(
            files2.len(),
            0,
            "dentro de repo, o .gitignore do topo aplica-se"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Um ficheiro grande saltado tem de ser CONTADO, não engolido.
    ///
    /// O corte de 1MB (paridade com `--max-filesize 1M`) vivia dentro do
    /// walker, portanto o ficheiro desaparecia sem rasto: uma busca por um
    /// símbolo que só existe num bundle, num dump SQL ou num schema gerado
    /// respondia "No matches found" e o modelo concluía que o símbolo não
    /// existe (auditoria 2026-07-29).
    #[test]
    fn files_over_the_size_cap_are_counted_not_swallowed() {
        let dir = std::env::temp_dir().join(format!("tm_big_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Ficheiro grande COM o acerto lá dentro.
        let mut big = String::with_capacity(MAX_SEARCH_FILESIZE as usize + 64);
        big.push_str("NEEDLE_IN_BIG_FILE\n");
        while big.len() <= MAX_SEARCH_FILESIZE as usize {
            big.push_str("filler filler filler filler\n");
        }
        std::fs::write(dir.join("bundle.js"), &big).unwrap();
        // E um pequeno sem o acerto, para o walk não ficar vazio.
        std::fs::write(dir.join("small.ts"), "nothing here\n").unwrap();
        let root = canonicalize_path(&dir).unwrap();

        let (files, total, _, skipped) =
            run_search("NEEDLE_IN_BIG_FILE", &root, &opts(None), GLOBAL_MAX_MATCHES).unwrap();

        assert!(files.is_empty(), "o ficheiro grande nao e procurado");
        assert_eq!(total, 0);
        assert_eq!(
            skipped, 1,
            "o salto tem de ser CONTADO — era este silencio que fazia o modelo \
             concluir que o simbolo nao existe"
        );
    }

    /// Content já não tem tecto por ficheiro (paridade cli-vaz). CountOnly
    /// continua a contar sem guardar texto.
    #[test]
    fn content_returns_all_hits_in_one_file_count_only_skips_text() {
        let dir = std::env::temp_dir().join(format!("tm_count_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let body = (0..25)
            .map(|i| format!("let needle{} = 1;", i))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.join("a.ts"), body).unwrap();
        let root = canonicalize_path(&dir).unwrap();
        let root = root.as_path();

        let (content_files, content_total, _, _) =
            run_search("needle", root, &opts(None), GLOBAL_MAX_MATCHES).unwrap();
        assert_eq!(content_files.len(), 1);
        assert_eq!(content_files[0].total_matches, 25);
        assert!(
            !content_files[0].capped_at_file_limit,
            "sem tecto por ficheiro, 25 < 500 não corta"
        );
        assert_eq!(content_total, 25);

        let mut counting = opts(None);
        counting.count_only = true;
        let (count_files, count_total, _, _) =
            run_search("needle", root, &counting, GLOBAL_MAX_MATCHES).unwrap();
        assert_eq!(count_files.len(), 1);
        assert_eq!(count_files[0].total_matches, 25, "CountOnly conta tudo");
        assert_eq!(count_total, 25);
        assert!(
            count_files[0].matches.is_empty(),
            "CountOnly não guarda texto de linha — é o que o torna barato"
        );
    }

    /// PathsOnly existe para o `replace_in_files`: um acerto por ficheiro, sem
    /// guardar texto de linhas que ninguem vai ler.
    #[test]
    fn paths_only_mode_reports_files_without_collecting_line_text() {
        let dir = std::env::temp_dir().join(format!("tm_paths_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 30 acertos num só ficheiro — acima do antigo tecto de 10/ficheiro.
        std::fs::write(dir.join("many.ts"), "MARKER\n".repeat(30)).unwrap();
        let root = canonicalize_path(&dir).unwrap();

        let (paths, n, _, _) = run_search_with_depth(
            "MARKER",
            &root,
            &opts(None),
            usize::MAX,
            SearchDepth::PathsOnly,
        )
        .unwrap();
        assert_eq!(paths.len(), 1);
        assert_eq!(n, 1, "PathsOnly conta ficheiros, nao acertos");
        assert!(
            paths[0].matches.is_empty(),
            "nao pode guardar texto de linhas"
        );

        let (content, _, _, _) =
            run_search("MARKER", &root, &opts(None), GLOBAL_MAX_MATCHES).unwrap();
        assert_eq!(content[0].matches.len(), 30);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_global_limit_matches_cli_vaz() {
        assert_eq!(resolve_global_limit(None), GLOBAL_MAX_MATCHES);
        assert_eq!(resolve_global_limit(Some(250)), 250);
        assert_eq!(resolve_global_limit(Some(0)), usize::MAX);
        assert_eq!(resolve_global_limit(Some(10)), 10);
    }

    /// O único corte em content é o head_limit GLOBAL: 25 acertos com
    /// limite 10 devolvem 10 e marcam o ficheiro como cortado a meio.
    #[test]
    fn content_global_head_limit_cuts_mid_file_not_at_ten() {
        let dir = std::env::temp_dir().join(format!("tm_head_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "needle\n".repeat(25)).unwrap();
        let root = canonicalize_path(&dir).unwrap();

        let (files, total, truncated, _) =
            run_search("needle", &root, &opts(None), 10).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].matches.len(), 10);
        assert_eq!(total, 10);
        assert!(files[0].capped_at_file_limit);
        assert!(truncated);

        let (all_files, all_total, _, _) =
            run_search("needle", &root, &opts(None), usize::MAX).unwrap();
        assert_eq!(all_files[0].matches.len(), 25);
        assert_eq!(all_total, 25);
        assert!(!all_files[0].capped_at_file_limit);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
