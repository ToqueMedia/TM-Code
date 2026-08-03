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
