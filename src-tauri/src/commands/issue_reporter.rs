use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueReportInput {
    pub description: String,
    pub email: String,
    /// All screenshots as base64-encoded JPEGs (without data URI prefix)
    #[serde(default)]
    pub screenshots: Vec<String>,
    pub system_info: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueReportResult {
    pub success: bool,
    pub message: String,
}

const RESEND_API_KEY: &str = "REDACTED_RESEND_KEY";
const RECIPIENT_EMAIL: &str = "geral@toquemedia.net";
const FROM_EMAIL: &str = "TM Code <noreply@toquemedia.net>";

/// Escape HTML special characters to prevent injection
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[tauri::command]
pub async fn send_issue_report(input: IssueReportInput) -> Result<IssueReportResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Build HTML email body
    let system_section = match &input.system_info {
        Some(info) => format!(
            r#"<div style="margin-top:24px;padding:16px;background:#1a1a1a;border-radius:8px;border:1px solid #333;">
                <h3 style="color:#FE1063;margin:0 0 12px 0;font-size:14px;">System Information</h3>
                <pre style="color:#8b949e;font-size:12px;margin:0;white-space:pre-wrap;font-family:monospace;">{}</pre>
            </div>"#,
            escape_html(info)
        ),
        None => String::new(),
    };

    // Reference attachments by name instead of embedding base64 inline
    let screenshot_section = if !input.screenshots.is_empty() {
        let count = input.screenshots.len();
        format!(
            r#"<div style="margin-top:24px;padding:12px 16px;background:rgba(254,16,99,0.06);border-radius:8px;border:1px solid rgba(254,16,99,0.15);">
                <span style="color:#FE1063;font-size:13px;font-weight:600;">📎 {} screenshot(s) attached</span>
            </div>"#,
            count
        )
    } else {
        String::new()
    };

    let html_body = format!(
        r#"<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#0a0a0a;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="max-width:700px;margin:0 auto;background:#111;border-radius:12px;border:1px solid #262626;overflow:hidden;">
        <div style="padding:20px 24px;background:linear-gradient(135deg,#FE1063 0%,#C10A69 100%);">
            <h1 style="margin:0;font-size:18px;color:#fff;">Issue Report — TM Code</h1>
        </div>
        <div style="padding:24px;">
            <div style="margin-bottom:16px;">
                <span style="color:#8b949e;font-size:12px;">From:</span>
                <span style="color:#e6edf3;font-size:13px;margin-left:8px;">{email}</span>
            </div>
            <div style="padding:16px;background:#1a1a1a;border-radius:8px;border:1px solid #333;">
                <h3 style="color:#FE1063;margin:0 0 12px 0;font-size:14px;">Description</h3>
                <div style="color:#e6edf3;font-size:13px;line-height:1.6;white-space:pre-wrap;">{description}</div>
            </div>
            {system_section}
            {screenshot_section}
        </div>
        <div style="padding:16px 24px;border-top:1px solid #262626;text-align:center;">
            <span style="color:#545b64;font-size:11px;">Sent from TM Code Issue Reporter</span>
        </div>
    </div>
</body>
</html>"#,
        email = escape_html(&input.email),
        description = escape_html(&input.description),
        system_section = system_section,
        screenshot_section = screenshot_section,
    );

    // Build attachments array — all screenshots as numbered JPEGs
    let attachments: Vec<serde_json::Value> = input
        .screenshots
        .iter()
        .enumerate()
        .map(|(i, b64)| {
            let filename = if i == 0 {
                "screenshot.jpg".to_string()
            } else {
                format!("screenshot_{}.jpg", i + 1)
            };
            serde_json::json!({
                "filename": filename,
                "content": b64,
            })
        })
        .collect();

    let subject = format!("Issue Report — TM Code [{}]", timestamp_now());

    let payload = serde_json::json!({
        "from": FROM_EMAIL,
        "to": [RECIPIENT_EMAIL],
        "reply_to": input.email,
        "subject": subject,
        "html": html_body,
        "attachments": attachments,
    });

    let resp = client
        .post("https://api.resend.com/emails")
        .header("Authorization", format!("Bearer {}", RESEND_API_KEY))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send report: {}", e))?;

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();

    if (200..300).contains(&status) {
        Ok(IssueReportResult {
            success: true,
            message: "Issue report sent successfully".to_string(),
        })
    } else {
        Ok(IssueReportResult {
            success: false,
            message: format!("Failed to send ({}): {}", status, body),
        })
    }
}

/// Timestamp with full date for unique email subjects
fn timestamp_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Manual UTC date + time (avoids pulling chrono crate)
    let days_since_epoch = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let mins = (time_of_day % 3600) / 60;

    // Calculate year/month/day from days since 1970-01-01
    let (year, month, day) = days_from_epoch(days_since_epoch);

    format!(
        "{:04}-{:02}-{:02} {:02}:{:02} UTC",
        year, month, day, hours, mins
    )
}

/// Convert days since Unix epoch to (year, month, day)
fn days_from_epoch(mut days: u64) -> (u64, u64, u64) {
    let mut year = 1970u64;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let months: [u64; 12] = if is_leap(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 1u64;
    for m in months {
        if days < m {
            break;
        }
        days -= m;
        month += 1;
    }
    (year, month, days + 1)
}

fn is_leap(y: u64) -> bool {
    y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400))
}
