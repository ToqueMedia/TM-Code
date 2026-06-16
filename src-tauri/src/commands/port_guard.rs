//! Guardião de porto — força o comportamento esperado de "porto ocupado →
//! salta para o próximo" nos dev servers lançados dentro do TM Code.
//!
//! O problema (incidente real, 2026-06-11): o Node ≥17 resolve `localhost`
//! IPv6-first, por isso um Vite lançado num terminal externo vincula apenas
//! `[::1]:5173` e deixa o lado IPv4 do porto LIVRE. Um segundo dev server
//! (no painel do TM Code) com `host: 0.0.0.0`/IPv4 vincula `*:5173` com
//! sucesso — dois servidores no "mesmo" porto, e o browser (IPv6 primeiro)
//! abre sempre o projeto externo. O servidor do TM Code fica "em
//! desvantagem" permanente.
//!
//! Solução: enquanto a IDE corre um dev server PRÓPRIO (gerido pelo
//! devServerManager, que regista os portos via `set_guarded_ports`), um
//! varrimento periódico detecta o estado "meio-ocupado" desses portos (IPv6
//! ocupado por um servidor externo, IPv4 livre) e RESERVA o lado IPv4 com um
//! listener próprio. Resultado: o próximo dev server IPv4 no painel falha o
//! bind no porto e salta automaticamente para o seguinte (5174, ...).
//!
//! Decisões deliberadas:
//!  - SÓ guardamos portos que a IDE está a gerir. Um `yarn dev` lançado à mão
//!    no PTY NUNCA é guardado — antes a lista era estática (3000/3001/5173/…)
//!    e a IDE reservava o IPv4 de qualquer porto de dev ocupado, aparecendo no
//!    `lsof:porto`; um `kill` cego nesse porto fechava a app. Agora a IDE só
//!    segura portos dos seus próprios servidores (que se param pelo botão Stop).
//!  - SÓ guardamos o lado IPv4 quando o IPv6 está ocupado. Nunca o inverso:
//!    os browsers tentam IPv6 primeiro e fazem fallback para IPv4 quando a
//!    ligação é recusada — ocupar [::1] com a nossa página intercetaria o
//!    tráfego destinado a um servidor IPv4-only legítimo.
//!  - O guard responde com uma página explicativa (409) em vez de deixar
//!    ligações penduradas — quem cair aqui percebe imediatamente o porquê.
//!  - O guard é libertado quando o servidor externo desaparece OU quando o
//!    porto deixa de ser gerido pela IDE (set_guarded_ports / dev server parado).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};

const SCAN_INTERVAL: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);

/// Portos que a IDE está ATIVAMENTE a gerir (definidos pelo frontend
/// devServerManager via `set_guarded_ports`). O guard só reserva o lado IPv4
/// DESTES — um dev server que o utilizador lança à mão no PTY nunca está aqui,
/// por isso a IDE nunca segura o porto dele e um `kill` nesse porto não pode
/// fechar a app (era o bug: a app aparecia no `lsof:3001`). Vazio por defeito:
/// sem dev server gerido, o guard não reserva nada.
fn managed_ports() -> &'static Mutex<HashSet<u16>> {
    static MANAGED: OnceLock<Mutex<HashSet<u16>>> = OnceLock::new();
    MANAGED.get_or_init(|| Mutex::new(HashSet::new()))
}

struct Guard {
    handle: tokio::task::JoinHandle<()>,
}

fn guards() -> &'static Mutex<HashMap<u16, Guard>> {
    static GUARDS: OnceLock<Mutex<HashMap<u16, Guard>>> = OnceLock::new();
    GUARDS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// O lado IPv6 do porto está ocupado? (ligação aceite = servidor presente)
async fn ipv6_occupied(port: u16) -> bool {
    matches!(
        tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(("::1", port))).await,
        Ok(Ok(_))
    )
}

fn notice_page(port: u16) -> String {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>TM Code — porto {port}</title></head>\
         <body style=\"font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">\
         <div style=\"max-width:560px;padding:32px\">\
         <h2 style=\"color:#FE1063\">Porto {port} reservado pelo TM Code</h2>\
         <p>Outro servidor já está a usar <code>[::1]:{port}</code> (IPv6). O TM Code reservou o lado IPv4 \
         para que novos dev servers saltem automaticamente para o próximo porto livre em vez de criarem \
         dois servidores no mesmo número.</p>\
         <p>O servidor real deste porto está em <strong>http://localhost:{port}</strong> (via IPv6).</p>\
         </div></body></html>"
    );
    format!(
        "HTTP/1.1 409 Conflict\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

/// Tenta reservar o lado IPv4 do porto. Sucesso → accept-loop com página
/// explicativa até a task ser abortada.
async fn try_hold_ipv4(port: u16) -> Option<tokio::task::JoinHandle<()>> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await.ok()?;
    eprintln!(
        "[port-guard] reservado 127.0.0.1:{} (IPv6 ocupado por servidor externo) — novos dev servers vão saltar de porto",
        port
    );
    let handle = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((mut stream, _)) => {
                    let response = notice_page(port);
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                }
                Err(_) => break,
            }
        }
    });
    Some(handle)
}

async fn scan_once() {
    // Só os portos que a IDE está a gerir (registados pelo devServerManager).
    // Sem dev server gerido, o conjunto está vazio e o guard não reserva nada.
    let ports: Vec<u16> = managed_ports()
        .lock()
        .map(|p| p.iter().copied().collect())
        .unwrap_or_default();
    for port in ports {
        let held = guards().lock().map(|g| g.contains_key(&port)).unwrap_or(false);
        let v6_busy = ipv6_occupied(port).await;

        if held && !v6_busy {
            // Servidor externo foi-se embora — liberta o porto.
            if let Ok(mut map) = guards().lock() {
                if let Some(guard) = map.remove(&port) {
                    guard.handle.abort();
                    eprintln!("[port-guard] libertado 127.0.0.1:{} (IPv6 ficou livre)", port);
                }
            }
        } else if !held && v6_busy {
            // Meio-ocupado: IPv6 tomado, IPv4 livre → reservar. Se o bind
            // falhar, já existe um servidor IPv4 real (split já instalado —
            // o aviso do painel cobre esse caso) ou outro processo; ignorar.
            if let Some(handle) = try_hold_ipv4(port).await {
                if let Ok(mut map) = guards().lock() {
                    map.insert(port, Guard { handle });
                }
            }
        }
    }
}

/// Frontend (devServerManager) regista o conjunto de portos que a IDE está a
/// gerir. O guard passa a reservar APENAS estes. Substitui o conjunto inteiro a
/// cada chamada (há um dev server gerido de cada vez); portos que saíram do
/// conjunto têm a reserva IPv4 libertada de imediato — sem esperar pelo scan.
#[tauri::command]
pub fn set_guarded_ports(ports: Vec<u16>) {
    let new_set: HashSet<u16> = ports.into_iter().collect();

    // Portos que deixaram de ser geridos → libertar já a reserva.
    let dropped: Vec<u16> = managed_ports()
        .lock()
        .map(|m| m.difference(&new_set).copied().collect())
        .unwrap_or_default();
    if !dropped.is_empty() {
        if let Ok(mut map) = guards().lock() {
            for port in &dropped {
                if let Some(guard) = map.remove(port) {
                    guard.handle.abort();
                    eprintln!(
                        "[port-guard] libertado 127.0.0.1:{} (deixou de ser gerido pela IDE)",
                        port
                    );
                }
            }
        }
    }

    if let Ok(mut managed) = managed_ports().lock() {
        *managed = new_set;
    }
}

/// Arranca o varrimento periódico. Chamado uma vez no setup da app.
pub fn start_port_guard() {
    tauri::async_runtime::spawn(async {
        loop {
            scan_once().await;
            tokio::time::sleep(SCAN_INTERVAL).await;
        }
    });
}
