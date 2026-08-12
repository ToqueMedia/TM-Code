//! Runner headless (P5 — docs/DESIGN-HEADLESS-RUNNER.md, 2026-08-03).
//!
//! `tm-code --run "<tarefa>" --project <dir> [--yolo]` arranca o MESMO
//! binário com a janela invisível: o motor corre onde sempre correu (o
//! webview), o job chega ao frontend por `runner_get_job`, o output NDJSON
//! sai por `runner_emit` (stdout) e o processo termina por `runner_exit`.
//! Nada disto especializa o motor — é apenas outro hospedeiro do contrato
//! AgentHost (ver src/services/agent/host/headlessHost.ts).

use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Serialize)]
pub struct RunnerJob {
    pub task: String,
    pub project: String,
    pub yolo: bool,
    /// Interruptores de MEDIÇÃO, por processo (`TM_RUN_KNOB_<NOME>=valor`).
    ///
    /// Porquê aqui e não em `import.meta.env` (2026-08-07): os primeiros
    /// interruptores de contexto (braço do orçamento, persona) eram env de
    /// BUILD do vite. Isso amarra cada corrida ao processo do vite que a serve
    /// — e um vite já vivo, seja de outra corrida seja do developer, não a
    /// ganha. O resultado é uma corrida que diz ter medido uma coisa e mediu
    /// outra: aconteceu a 07-08 com 12 corridas (2 braços × 2 personas) a
    /// medirem todas a MESMA célula.
    ///
    /// Por aqui é por PROCESSO: o binário do runner lê a env que lhe foi dada,
    /// e o mesmo vite pode servir corridas com interruptores diferentes. É um
    /// mapa aberto de propósito — um interruptor novo não precisa de tocar em
    /// Rust nem de reconstruir o binário.
    pub knobs: std::collections::HashMap<String, String>,
}

static RUNNER_JOB: Mutex<Option<RunnerJob>> = Mutex::new(None);

pub fn set_runner_job(job: RunnerJob) {
    if let Ok(mut slot) = RUNNER_JOB.lock() {
        *slot = Some(job);
    }
}

/// True quando o processo foi lançado com `--run` — mantém janela e splash
/// invisíveis e desactiva o failsafe de show do splash.
pub fn runner_mode_active() -> bool {
    RUNNER_JOB.lock().map(|s| s.is_some()).unwrap_or(false)
}

#[tauri::command]
pub fn runner_get_job() -> Option<RunnerJob> {
    RUNNER_JOB.lock().ok().and_then(|s| s.clone())
}

/// Escreve uma linha (NDJSON) no stdout do processo — o canal de saída do
/// runner. O frontend serializa; aqui garante-se só linha inteira + flush.
#[tauri::command]
pub fn runner_emit(line: String) {
    use std::io::Write;
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// Termina o processo do runner com o exit code dado (flush primeiro).
#[tauri::command]
pub fn runner_exit(code: i32) {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    std::process::exit(code);
}
