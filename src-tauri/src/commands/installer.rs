//! One-click installation of required dev tools (Python, Node.js, Git).
//!
//! Windows-only by design: macOS/Linux users that reach this IDE are assumed to
//! be technical enough to install tooling themselves, so the frontend keeps the
//! old "open the official download page" path there. On Windows we want a
//! genuine one-click experience for non-technical users.
//!
//! Strategy (per tool):
//!   A. winget (App Installer) — auto-updating, zero mirror maintenance. winget
//!      raises its own UAC prompt when a package needs elevation.
//!   B. Fallback: download the official installer (the URL the frontend already
//!      keeps in WINDOWS_DOWNLOAD_LINKS) and run it silently:
//!        - python → per-user, /quiet InstallAllUsers=0 PrependPath=1  → NO UAC
//!        - node   → msiexec /qn ADDLOCAL=ALL                          → needs UAC
//!        - git    → Inno Setup /VERYSILENT                            → needs UAC
//!      Elevation (node/git) goes through a single `Start-Process -Verb RunAs`.
//!
//! After a successful install we refresh THIS process's PATH from the registry
//! (see `refresh_process_path`) so the existing detection in ToolsStep.tsx finds
//! the tool without an app restart.

use serde::Serialize;
use tauri::AppHandle;

/// Progress event payload, emitted on the `tool-install-progress` channel.
/// `phase`: winget | downloading | installing | refreshing | done | error
#[allow(dead_code)] // fields are only read on Windows
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    tool: String,
    phase: String,
    percent: Option<f64>,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub success: bool,
    /// "winget" or "installer" — which path actually performed the install.
    pub method: String,
    pub message: String,
}

/// Install a dev tool (`python` | `node` | `git`) on Windows.
///
/// `download_url` is the official-installer fallback URL (from the frontend's
/// WINDOWS_DOWNLOAD_LINKS); it is only used if winget is unavailable or fails.
#[tauri::command]
pub async fn install_dev_tool(
    tool_id: String,
    download_url: String,
    app: AppHandle,
) -> Result<InstallResult, String> {
    #[cfg(target_os = "windows")]
    {
        win::install(tool_id, download_url, app).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (tool_id, download_url, app);
        Err("A instalação automática só está disponível no Windows.".into())
    }
}

#[cfg(target_os = "windows")]
mod win {
    use super::{InstallProgress, InstallResult};
    use futures_util::StreamExt;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use tokio::io::AsyncWriteExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    fn emit(app: &AppHandle, tool: &str, phase: &str, percent: Option<f64>, message: Option<&str>) {
        let _ = app.emit(
            "tool-install-progress",
            InstallProgress {
                tool: tool.to_string(),
                phase: phase.to_string(),
                percent,
                message: message.map(|s| s.to_string()),
            },
        );
    }

    /// winget package id per tool. Kept in sync with the manual commands the
    /// frontend already shows (getManualCommand in ToolsStep.tsx).
    fn winget_id(tool: &str) -> Option<&'static str> {
        match tool {
            "python" => Some("Python.Python.3.12"),
            "node" => Some("OpenJS.NodeJS.LTS"),
            "git" => Some("Git.Git"),
            _ => None,
        }
    }

    /// Command name used to verify the tool is on PATH after install.
    fn verify_cmd(tool: &str) -> &'static str {
        match tool {
            "python" => "python",
            "node" => "node",
            "git" => "git",
            _ => "",
        }
    }

    fn winget_available() -> bool {
        let mut c = Command::new("winget");
        c.arg("--version")
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        c.status().map(|s| s.success()).unwrap_or(false)
    }

    fn run_winget(id: &str) -> Result<i32, String> {
        let mut c = Command::new("winget");
        c.args([
            "install",
            "-e",
            "--id",
            id,
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
        let out = c
            .output()
            .map_err(|e| format!("Falha a executar winget: {}", e))?;
        Ok(out.status.code().unwrap_or(-1))
    }

    async fn download(app: &AppHandle, tool: &str, url: &str) -> Result<PathBuf, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .user_agent("TM-Code-Installer/1.0")
            .build()
            .map_err(|e| format!("Falha a criar cliente HTTP: {}", e))?;

        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Falha a descarregar instalador: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("Download falhou: HTTP {}", resp.status().as_u16()));
        }

        // .msi (node) vs .exe (python, git) — derive from the URL.
        let ext = if url.to_lowercase().contains(".msi") {
            "msi"
        } else {
            "exe"
        };
        let mut path = std::env::temp_dir();
        path.push(format!("tmcode-{}-installer.{}", tool, ext));

        let total = resp.content_length();
        let mut file = tokio::fs::File::create(&path)
            .await
            .map_err(|e| format!("Falha a criar ficheiro temporário: {}", e))?;

        let mut downloaded: u64 = 0;
        let mut last_pct: i64 = -1;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Erro durante o download: {}", e))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Falha a gravar instalador: {}", e))?;
            downloaded += chunk.len() as u64;
            if let Some(total) = total {
                if total > 0 {
                    let pct = ((downloaded as f64 / total as f64) * 100.0).floor() as i64;
                    if pct != last_pct {
                        last_pct = pct;
                        emit(app, tool, "downloading", Some(pct as f64), None);
                    }
                }
            }
        }
        file.flush()
            .await
            .map_err(|e| format!("Falha a finalizar download: {}", e))?;
        Ok(path)
    }

    /// (program, args, needs_elevation) for running the downloaded installer silently.
    fn silent_invocation(tool: &str, installer: &str) -> Result<(String, Vec<String>, bool), String> {
        match tool {
            // Per-user install → no UAC; PrependPath=1 puts python + pip on PATH.
            "python" => Ok((
                installer.to_string(),
                vec![
                    "/quiet".into(),
                    "InstallAllUsers=0".into(),
                    "PrependPath=1".into(),
                    "Include_pip=1".into(),
                ],
                false,
            )),
            // MSI is machine-scoped → needs elevation. Adds node to PATH by default.
            "node" => Ok((
                "msiexec".into(),
                vec![
                    "/i".into(),
                    installer.to_string(),
                    "/qn".into(),
                    "/norestart".into(),
                    "ADDLOCAL=ALL".into(),
                ],
                true,
            )),
            // Git for Windows (Inno Setup) → machine-scoped, needs elevation.
            "git" => Ok((
                installer.to_string(),
                vec![
                    "/VERYSILENT".into(),
                    "/NORESTART".into(),
                    "/NOCANCEL".into(),
                    "/SP-".into(),
                    "/SUPPRESSMSGBOXES".into(),
                ],
                true,
            )),
            other => Err(format!("Ferramenta desconhecida: {}", other)),
        }
    }

    fn run_silent(program: &str, args: &[String], needs_elevation: bool) -> Result<i32, String> {
        if needs_elevation {
            // One UAC prompt via Start-Process -Verb RunAs. -Wait blocks until the
            // installer finishes; -PassThru exposes its exit code.
            let arg_list = args
                .iter()
                .map(|a| format!("'{}'", a.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(",");
            let script = format!(
                "$p = Start-Process -FilePath '{}' -ArgumentList {} -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
                program.replace('\'', "''"),
                arg_list,
            );
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .stdin(Stdio::null());
            let out = c
                .output()
                .map_err(|e| format!("Falha a iniciar o instalador: {}", e))?;
            if !out.status.success() {
                // User declined the UAC prompt → ShellExecute throws (Win32 1223).
                let err = String::from_utf8_lossy(&out.stderr);
                if err.contains("canceled")
                    || err.contains("cancelled")
                    || err.contains("1223")
                {
                    return Err("Instalação cancelada no pedido de permissão (UAC).".into());
                }
            }
            Ok(out.status.code().unwrap_or(-1))
        } else {
            let mut c = Command::new(program);
            c.args(args)
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .stdin(Stdio::null());
            let status = c
                .status()
                .map_err(|e| format!("Falha a executar o instalador: {}", e))?;
            Ok(status.code().unwrap_or(-1))
        }
    }

    /// Re-read the merged Machine+User PATH from the registry and update THIS
    /// process's PATH. Windows only propagates PATH changes to processes started
    /// after the installer ran; our long-lived process keeps the stale PATH
    /// otherwise, so freshly-installed tools would stay invisible to
    /// `execute_command`/`command_exists` until an app restart. PowerShell's
    /// GetEnvironmentVariable expands REG_EXPAND_SZ entries for us.
    fn refresh_process_path() {
        let script = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        if let Ok(out) = c.output() {
            if out.status.success() {
                let merged = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !merged.is_empty() {
                    // Safe on edition 2021. Called from a blocking task, not
                    // concurrently with other PATH writers.
                    std::env::set_var("PATH", merged);
                }
            }
        }
    }

    fn verify_installed(tool: &str) -> bool {
        let cmd = verify_cmd(tool);
        if cmd.is_empty() {
            return false;
        }
        let mut c = Command::new("where");
        c.arg(cmd)
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        c.status().map(|s| s.success()).unwrap_or(false)
    }

    async fn finish(app: &AppHandle, tool: &str, method: &str) -> Result<InstallResult, String> {
        emit(app, tool, "refreshing", None, None);
        let t = tool.to_string();
        let ok = tokio::task::spawn_blocking(move || {
            refresh_process_path();
            verify_installed(&t)
        })
        .await
        .unwrap_or(false);

        emit(app, tool, if ok { "done" } else { "error" }, None, None);
        Ok(InstallResult {
            success: ok,
            method: method.to_string(),
            message: if ok {
                "Instalado com sucesso.".into()
            } else {
                "Instalação concluída, mas a ferramenta ainda não foi detectada. Pode ser necessário reiniciar a aplicação.".into()
            },
        })
    }

    pub async fn install(
        tool_id: String,
        download_url: String,
        app: AppHandle,
    ) -> Result<InstallResult, String> {
        let tool = tool_id;
        if verify_cmd(&tool).is_empty() {
            return Err(format!("Ferramenta não suportada: {}", tool));
        }

        // ── Path A: winget ──────────────────────────────────────────────────
        let have_winget = tokio::task::spawn_blocking(winget_available)
            .await
            .unwrap_or(false);
        if have_winget {
            if let Some(id) = winget_id(&tool) {
                emit(&app, &tool, "winget", None, Some("A instalar via winget…"));
                let id_s = id.to_string();
                let code = tokio::task::spawn_blocking(move || run_winget(&id_s))
                    .await
                    .map_err(|e| format!("Erro interno: {}", e))??;
                if code == 0 {
                    return finish(&app, &tool, "winget").await;
                }
                emit(
                    &app,
                    &tool,
                    "winget",
                    None,
                    Some("winget falhou; a tentar o instalador oficial…"),
                );
                // fall through to the direct-installer fallback
            }
        }

        // ── Path B: official installer, downloaded and run silently ─────────
        if download_url.trim().is_empty() {
            return Err("Sem URL de instalador para fallback.".into());
        }
        emit(&app, &tool, "downloading", Some(0.0), None);
        let installer = download(&app, &tool, &download_url).await?;
        let installer_str = installer.to_string_lossy().to_string();

        emit(&app, &tool, "installing", None, None);
        let (program, args, elevate) = silent_invocation(&tool, &installer_str)?;
        let code = tokio::task::spawn_blocking(move || run_silent(&program, &args, elevate))
            .await
            .map_err(|e| format!("Erro interno: {}", e))??;

        // Best-effort cleanup of the temp installer.
        let _ = std::fs::remove_file(&installer);

        // msiexec: 0 = ok, 3010 = ok-but-reboot-required. exe installers: 0 = ok.
        if code != 0 && code != 3010 {
            return Err(format!("O instalador terminou com o código {}.", code));
        }
        finish(&app, &tool, "installer").await
    }
}
