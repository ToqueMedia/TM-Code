use sha2::{Digest, Sha256};

/// Returns a stable, opaque hash that identifies this physical machine.
///
/// Inputs combined: machine UUID (IORegistry on macOS, /etc/machine-id on
/// Linux, MachineGuid registry key on Windows) + OS family. Hostname is
/// **deliberately excluded** — it's user-mutable (`scutil --set HostName`,
/// `hostnamectl`, Windows control panel) and would let an attacker generate
/// a fresh fingerprint per signup just by renaming the machine.
///
/// Hash is SHA-256 → hex, truncated to 32 chars (128 bits — enough collision
/// resistance for an abuse-prevention identifier without exposing the raw
/// machine UUID).
///
/// Survives app reinstalls and most user-data wipes. Defeated by reinstalling
/// the OS or running in a fresh VM — accepted tradeoff at this layer; the
/// backend rate-limits per-IP to raise the cost further.
#[tauri::command]
pub fn get_device_fingerprint() -> Result<String, String> {
    let machine_id = machine_uid::get().map_err(|e| format!("machine_uid: {e}"))?;
    let os = std::env::consts::OS;

    let mut hasher = Sha256::new();
    hasher.update(b"tmcode-fp-v2|");
    hasher.update(machine_id.as_bytes());
    hasher.update(b"|");
    hasher.update(os.as_bytes());

    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Ok(hex[..32].to_string())
}
