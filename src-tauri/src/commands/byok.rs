//! BYOK (Bring Your Own Key) keychain commands.
//!
//! Stores per-provider API keys with two strategies:
//!   1. **OS keychain** (preferred) — macOS Security framework, Windows
//!      Credential Manager, Linux libsecret. Real OS-level protection.
//!   2. **Encrypted file fallback** — when keychain isn't available
//!      (unsigned dev builds where macOS silently rejects writes, Linux
//!      without libsecret running). XOR obfuscation with a machine-UID-
//!      derived keystream + Unix mode 0600 on the file. NOT real crypto;
//!      just enough to defeat opportunistic file scanners and to make the
//!      key non-trivial to read with `cat`.
//!
//! The fallback is automatic — `byok_set_key` writes to keychain first and
//! verifies with `get_password`. If verify fails (key didn't actually
//! persist, classic dev-build symptom on macOS), it falls back to the file.
//! `byok_get_key` and `byok_has_key` check keychain first, then file.
//!
//! Keys NEVER appear in Zustand state, localStorage, or any persisted IDE
//! config — only metadata ("provider X has a key set") lives in byokStore.
//! `byok_get_key` is called from agentService just-in-time when building a
//! chat request; the key never sits in renderer-process memory longer than
//! the duration of one fetch.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use keyring::Entry;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "tm-code-byok";

fn entry_for(provider: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, provider).map_err(|e| format!("keyring init failed: {e}"))
}

// ── File fallback ──

fn fallback_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "platform data_dir unavailable".to_string())?;
    let dir = base.join("toquemedia-studio").join("byok");
    fs::create_dir_all(&dir).map_err(|e| format!("byok dir create failed: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }

    Ok(dir)
}

fn fallback_path(provider: &str) -> Result<PathBuf, String> {
    Ok(fallback_dir()?.join(format!("{provider}.key")))
}

/// XOR obfuscate (symmetric — same call decrypts) with a keystream derived
/// from the machine UID and provider id. Not real crypto; defeats casual
/// scanners. The file is also chmod 0600 so other users on the machine
/// can't read it.
fn xor_obfuscate(data: &[u8], provider: &str) -> Vec<u8> {
    let machine = machine_uid::get().unwrap_or_else(|_| "no-machine-uid".to_string());
    let mut hasher = Sha256::new();
    hasher.update(format!("byok-fallback-v1|{machine}|{provider}").as_bytes());
    let mut keystream = hasher.finalize().to_vec();

    while keystream.len() < data.len() {
        let mut h = Sha256::new();
        h.update(&keystream);
        keystream.extend_from_slice(&h.finalize());
    }

    data.iter()
        .zip(keystream.iter())
        .map(|(b, k)| b ^ k)
        .collect()
}

fn write_fallback(provider: &str, key: &str) -> Result<(), String> {
    let path = fallback_path(provider)?;
    let obfuscated = xor_obfuscate(key.as_bytes(), provider);
    let encoded = B64.encode(&obfuscated);

    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }

    let mut file = opts
        .open(&path)
        .map_err(|e| format!("fallback open failed: {e}"))?;
    file.write_all(encoded.as_bytes())
        .map_err(|e| format!("fallback write failed: {e}"))?;
    Ok(())
}

fn read_fallback(provider: &str) -> Result<Option<String>, String> {
    let path = fallback_path(provider)?;
    if !path.exists() {
        return Ok(None);
    }
    let encoded = fs::read_to_string(&path).map_err(|e| format!("fallback read failed: {e}"))?;
    let obfuscated = B64
        .decode(encoded.trim())
        .map_err(|e| format!("fallback decode failed: {e}"))?;
    let plain = xor_obfuscate(&obfuscated, provider);
    let key = String::from_utf8(plain).map_err(|e| format!("fallback utf8: {e}"))?;
    Ok(Some(key))
}

fn delete_fallback(provider: &str) -> Result<(), String> {
    let path = fallback_path(provider)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("fallback delete failed: {e}"))?;
    }
    Ok(())
}

// ── Tauri commands ──

#[tauri::command]
pub fn byok_set_key(provider: String, key: String) -> Result<(), String> {
    if provider.is_empty() {
        return Err("provider is required".into());
    }
    if key.is_empty() {
        return Err("key is required".into());
    }

    // Write to BOTH stores. The macOS keychain in unsigned dev builds will
    // sometimes accept set_password and even pass an immediate verify, but
    // then drop the entry between sessions. If we relied on the keychain
    // alone (or — worse — deleted the file fallback after a keychain
    // success), the next byok_has_key call would return false and the IDE
    // would flip `hasKey` to false on every window-restore refresh.
    //
    // Treating the file as the durable source of truth and the keychain as
    // a faster-path cache eliminates that drift entirely.
    let keychain_state: &str = if let Ok(entry) = entry_for(&provider) {
        match entry.set_password(&key) {
            Ok(()) => match entry.get_password() {
                Ok(stored) if stored == key => "ok",
                Ok(_) => "set-but-readback-mismatch",
                Err(_) => "set-but-readback-noentry",
            },
            Err(e) => {
                eprintln!("[byok] keychain set failed for {provider}: {e}");
                "set-failed"
            }
        }
    } else {
        "init-failed"
    };

    // Always write the file fallback — durable source of truth.
    write_fallback(&provider, &key)?;
    eprintln!("[byok] set_key({provider}) -> keychain={keychain_state}, file=ok");
    Ok(())
}

#[tauri::command]
pub fn byok_get_key(provider: String) -> Result<Option<String>, String> {
    if provider.is_empty() {
        return Err("provider is required".into());
    }

    if let Ok(entry) = entry_for(&provider) {
        match entry.get_password() {
            Ok(pw) => return Ok(Some(pw)),
            Err(keyring::Error::NoEntry) => { /* fall through to file */ }
            Err(_) => { /* keychain error — try file before failing */ }
        }
    }

    read_fallback(&provider)
}

#[tauri::command]
pub fn byok_delete_key(provider: String) -> Result<(), String> {
    if provider.is_empty() {
        return Err("provider is required".into());
    }

    // Best-effort delete from BOTH stores. If either succeeds, treat as ok.
    let mut keychain_err: Option<String> = None;
    if let Ok(entry) = entry_for(&provider) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => keychain_err = Some(format!("keyring delete failed: {e}")),
        }
    }

    let file_err = delete_fallback(&provider).err();

    match (keychain_err, file_err) {
        (None, None) => Ok(()),
        // Both failed — surface the keychain error first
        (Some(k), Some(_)) => Err(k),
        (Some(k), None) => Err(k),
        (None, Some(f)) => Err(f),
    }
}

#[tauri::command]
pub fn byok_has_key(provider: String) -> Result<bool, String> {
    if provider.is_empty() {
        return Err("provider is required".into());
    }

    if let Ok(entry) = entry_for(&provider) {
        match entry.get_password() {
            Ok(_) => {
                eprintln!("[byok] has_key({provider}) -> true (keychain)");
                return Ok(true);
            }
            Err(keyring::Error::NoEntry) => { /* fall through */ }
            Err(e) => {
                eprintln!("[byok] has_key({provider}) keychain error: {e} — checking file");
            }
        }
    }

    let path = fallback_path(&provider)?;
    let exists = path.exists();
    eprintln!(
        "[byok] has_key({provider}) -> {exists} (file at {})",
        path.display()
    );
    Ok(exists)
}
