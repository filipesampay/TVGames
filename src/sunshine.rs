//! Sunshine web API client and library sync.
//! Apps created by tvgames are recognised by their `cmd` (`.../tvgames launch <id>`);
//! every other app (Desktop, Steam Big Picture, ...) is left untouched.

use crate::config::SunshineCfg;
use crate::model::Game;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

pub const MARKER: &str = "tvgames launch ";
/// Keys tvgames sets; only these are compared to decide if a resync is needed.
const KEYS: &[&str] = &["name", "cmd", "image-path", "prep-cmd", "exit-timeout", "auto-detach", "wait-all"];

pub struct Sunshine {
    http: reqwest::blocking::Client,
    base: String,
    user: String,
    pass: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct SyncReport {
    pub removed: usize,
    pub added: usize,
    pub unchanged: bool,
}

impl Sunshine {
    pub fn new(cfg: &SunshineCfg) -> Result<Self> {
        let url = reqwest::Url::parse(&cfg.url).context("sunshine.url")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        if cfg.password.is_empty() {
            bail!("sunshine.password is empty in config.toml");
        }
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            // Sunshine uses a self-signed cert; only trust it blindly on this machine.
            .danger_accept_invalid_certs(local)
            .build()?;
        Ok(Self {
            http,
            base: cfg.url.trim_end_matches('/').to_string(),
            user: cfg.username.clone(),
            pass: cfg.password.clone(),
        })
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::blocking::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.base))
            .basic_auth(&self.user, Some(&self.pass))
            .header("Origin", &self.base)
    }

    pub fn apps(&self) -> Result<Vec<Value>> {
        let resp = self.req(reqwest::Method::GET, "/api/apps").send()?;
        let v: Value = check(resp)?;
        Ok(v["apps"].as_array().cloned().unwrap_or_default())
    }

    pub fn add(&self, app: &Value) -> Result<()> {
        let mut body = app.clone();
        body["index"] = json!(-1);
        check(self.req(reqwest::Method::POST, "/api/apps").json(&body).send()?)?;
        Ok(())
    }

    pub fn delete(&self, index: usize) -> Result<()> {
        check(self.req(reqwest::Method::DELETE, &format!("/api/apps/{index}")).send()?)?;
        Ok(())
    }

    /// Closes the running app (ends the stream on the client too).
    pub fn close_app(&self) -> Result<()> {
        check(self.req(reqwest::Method::POST, "/api/apps/close").send()?)?;
        Ok(())
    }

    /// Makes the managed apps equal to `desired` (in order).
    pub fn sync(&self, desired: &[Value]) -> Result<SyncReport> {
        let apps = self.apps()?;
        let managed: Vec<(usize, &Value)> = apps.iter().enumerate().filter(|(_, a)| is_managed(a)).collect();
        let current: Vec<Value> = managed.iter().map(|(_, a)| project(a)).collect();
        let wanted: Vec<Value> = desired.iter().map(project).collect();
        if current == wanted {
            return Ok(SyncReport { unchanged: true, ..Default::default() });
        }
        let mut report = SyncReport::default();
        for (idx, _) in managed.iter().rev() {
            self.delete(*idx)?;
            report.removed += 1;
        }
        for app in desired {
            self.add(app)?;
            report.added += 1;
        }
        Ok(report)
    }
}

/// Sunshine's assets folder (`SUNSHINE_ASSETS_DIR`).
pub const ASSETS_DIR: &str = "/usr/share/sunshine";

/// The ids Sunshine assigns to `apps` (in file order), as Moonlight sees them.
/// Mirrors `calculate_app_id` in Sunshine's src/process.cpp (2026.914):
/// CRC-32 of name + SHA-256 hex of the app image, `abs()` as int32; on
/// collision the app's index is appended to the hashed input.
pub fn app_ids(apps: &[Value], assets_dir: &Path) -> Vec<String> {
    let mut used = std::collections::HashSet::new();
    apps.iter()
        .enumerate()
        .map(|(i, app)| {
            let mut input = app["name"].as_str().unwrap_or("").to_string();
            if let Some(img) = resolve_image(app["image-path"].as_str().unwrap_or(""), assets_dir) {
                input.push_str(&sha256_hex(&img).unwrap_or_else(|| img.display().to_string()));
            }
            let mut id = crc_id(&input);
            if used.contains(&id) {
                id = crc_id(&format!("{input}{i}"));
            }
            used.insert(id.clone());
            id
        })
        .collect()
}

fn crc_id(input: &str) -> String {
    (crc32fast::hash(input.as_bytes()) as i32).wrapping_abs().to_string()
}

/// `validate_app_image_path`: `None` means Sunshine's default box image,
/// which is not part of the id.
fn resolve_image(image: &str, assets_dir: &Path) -> Option<std::path::PathBuf> {
    if image.is_empty() || !image.to_ascii_lowercase().ends_with(".png") {
        return None;
    }
    let in_assets = assets_dir.join(image);
    if in_assets.exists() {
        return is_png(&in_assets).then_some(in_assets);
    }
    if image == "./assets/steam.png" {
        return Some(assets_dir.join("steam.png"));
    }
    let p = Path::new(image);
    (p.exists() && is_png(p)).then(|| p.to_path_buf())
}

fn is_png(p: &Path) -> bool {
    let mut sig = [0u8; 8];
    std::fs::File::open(p).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut sig)).is_ok()
        && sig == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
}

fn sha256_hex(p: &Path) -> Option<String> {
    use sha2::Digest;
    let bytes = std::fs::read(p).ok()?;
    Some(sha2::Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect())
}

fn check(resp: reqwest::blocking::Response) -> Result<Value> {
    let status = resp.status();
    let body: Value = resp.json().unwrap_or(Value::Null);
    if !status.is_success() || body["status"] == json!(false) {
        bail!("Sunshine API error {status}: {body}");
    }
    Ok(body)
}

pub fn is_managed(app: &Value) -> bool {
    app["cmd"].as_str().is_some_and(|c| c.contains(MARKER))
}

fn project(app: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for k in KEYS {
        if let Some(v) = app.get(*k) {
            out.insert((*k).to_string(), v.clone());
        }
    }
    Value::Object(out)
}

/// Sunshine app entry for a game. `exe` is the installed `tvgames` binary.
pub fn app_for(game: &Game, exe: &Path, image: Option<&Path>) -> Value {
    let exe = exe.display();
    let mut app = json!({
        "name": game.title,
        "cmd": format!("{exe} launch {}", game.id),
        "prep-cmd": [{ "do": format!("{exe} session start"), "undo": format!("{exe} session stop") }],
        "exit-timeout": 15,
        "auto-detach": true,
        "wait-all": true,
    });
    if let Some(img) = image {
        app["image-path"] = json!(img.display().to_string());
    }
    app
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::WaitSpec;

    #[test]
    fn app_entry_is_managed_and_carries_session_hooks() {
        let g = Game {
            id: "steam:570".into(),
            title: "Dota 2".into(),
            provider: "steam".into(),
            category: "Steam".into(),
            launcher: false,
            rom: None,
            platform: None,
            launch: vec![],
            env: vec![],
            wait: WaitSpec::Child,
            art: None,
        };
        let app = app_for(&g, Path::new("/home/u/.cargo/bin/tvgames"), Some(Path::new("/c/a.png")));
        assert_eq!(app["cmd"], "/home/u/.cargo/bin/tvgames launch steam:570");
        assert_eq!(app["prep-cmd"][0]["undo"], "/home/u/.cargo/bin/tvgames session stop");
        assert_eq!(app["image-path"], "/c/a.png");
        assert!(is_managed(&app));
        assert!(!is_managed(&json!({"name": "Desktop"})));
    }

    #[test]
    fn app_ids_follow_sunshine_algorithm() {
        let tmp = tempfile::tempdir().unwrap();
        let png = tmp.path().join("c.png");
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(b"rest");
        std::fs::write(&png, &bytes).unwrap();
        let apps = vec![
            json!({"name": "Desktop"}),
            json!({"name": "Game", "image-path": png.display().to_string()}),
            json!({"name": "Desktop"}),
        ];
        let ids = app_ids(&apps, tmp.path());
        // no image: CRC-32 of the name only
        assert_eq!(ids[0], (crc32fast::hash(b"Desktop") as i32).wrapping_abs().to_string());
        // with image: name + sha256 hex of the file
        let sha = sha256_hex(&png).unwrap();
        assert_eq!(ids[1], (crc32fast::hash(format!("Game{sha}").as_bytes()) as i32).wrapping_abs().to_string());
        // collision: index appended
        assert_eq!(ids[2], (crc32fast::hash(b"Desktop2") as i32).wrapping_abs().to_string());
    }

    #[test]
    fn projection_ignores_extra_server_fields() {
        let a = json!({"name": "X", "cmd": "t launch x", "uuid": "abc"});
        let b = json!({"cmd": "t launch x", "name": "X"});
        assert_eq!(project(&a), project(&b));
    }
}
