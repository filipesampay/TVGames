//! `tvgames serve`: small LAN HTTP API for the TV app.
//!
//! - `GET /api/library` → host info + every published game with its Sunshine
//!   app id (what Moonlight needs to launch it directly), category and cover.
//! - `GET /art/<file>.png` → cover images from `~/.cache/tvgames/art`.
//! - `GET /api/health`

use crate::cheevos;
use crate::config::{cache_dir, Config};
use crate::model::Game;
use crate::sunshine::{self, Sunshine};
use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Serialize)]
struct Library {
    host: Host,
    /// RetroAchievements profile, when logged in with a Web API key.
    profile: Option<cheevos::Profile>,
    categories: Vec<String>,
    games: Vec<Entry>,
}

#[derive(Serialize)]
struct Host {
    name: String,
    uuid: String,
}

#[derive(Serialize)]
struct Entry {
    id: String,
    title: String,
    tags: Vec<String>,
    category: String,
    launcher: bool,
    /// Exact Sunshine app name and id (Moonlight `AppName` / `AppId` extras).
    app_name: String,
    app_id: String,
    cover: Option<String>,
    achievements: Option<cheevos::GameProgress>,
}

pub fn serve(cfg: &Config, bind: &str) -> Result<()> {
    let server = tiny_http::Server::http(bind).map_err(|e| anyhow::anyhow!("binding {bind}: {e}"))?;
    spawn_cheevos_refresher(cfg.clone());
    eprintln!("tvgames: serving on http://{bind}");
    for req in server.incoming_requests() {
        let url = req.url().split('?').next().unwrap_or("").to_string();
        let resp = match (req.method(), url.as_str()) {
            (tiny_http::Method::Get, "/api/health") => json(200, &serde_json::json!({"ok": true})),
            (tiny_http::Method::Get, "/api/library") => match library(cfg) {
                Ok(lib) => json(200, &lib),
                Err(e) => {
                    eprintln!("tvgames: /api/library: {e:#}");
                    json(500, &serde_json::json!({"error": format!("{e:#}")}))
                }
            },
            (tiny_http::Method::Get, path) if path.starts_with("/art/") => art(&path[5..]),
            _ => json(404, &serde_json::json!({"error": "not found"})),
        };
        let _ = req.respond(resp);
    }
    Ok(())
}

type Resp = tiny_http::Response<std::io::Cursor<Vec<u8>>>;

fn json<T: Serialize>(status: u16, body: &T) -> Resp {
    let data = serde_json::to_vec(body).unwrap_or_default();
    tiny_http::Response::from_data(data)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
}

fn header(k: &str, v: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("valid header")
}

fn art(name: &str) -> Resp {
    // Only plain file names from our own cache dir.
    let ok = !name.is_empty()
        && name.ends_with(".png")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !name.contains("..");
    let data = ok.then(|| std::fs::read(cache_dir().join("art").join(name)).ok()).flatten();
    match data {
        Some(bytes) => tiny_http::Response::from_data(bytes)
            .with_header(header("Content-Type", "image/png"))
            .with_header(header("Cache-Control", "max-age=3600")),
        None => json(404, &serde_json::json!({"error": "not found"})),
    }
}

/// Keeps RetroAchievements progress fresh in the background: at start, every
/// 10 minutes, and right after a game session ends (`session stop` marks it).
fn spawn_cheevos_refresher(cfg: Config) {
    if cfg.retroachievements.username.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let mut last: Option<std::time::Instant> = None;
        loop {
            let dirty = cheevos::take_dirty();
            let due = last.is_none_or(|t| t.elapsed() >= std::time::Duration::from_secs(600));
            if dirty || due {
                let games: Vec<Game> = std::fs::read_to_string(cache_dir().join("library.json"))
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
                    .unwrap_or_default();
                // After a session, give RetroAchievements a moment to record unlocks.
                if dirty {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                }
                cheevos::refresh(&cfg, &games, dirty);
                last = Some(std::time::Instant::now());
            }
            std::thread::sleep(std::time::Duration::from_secs(15));
        }
    });
}

fn library(cfg: &Config) -> Result<Library> {
    let ra = cheevos::load_cache();
    let apps = Sunshine::new(&cfg.sunshine)?.apps()?;
    let ids = sunshine::app_ids(&apps, Path::new(sunshine::ASSETS_DIR));
    let cache = std::fs::read_to_string(cache_dir().join("library.json")).context("library cache (run tvgames sync)")?;
    let games: HashMap<String, Game> =
        serde_json::from_str::<Vec<Game>>(&cache)?.into_iter().map(|g| (g.id.clone(), g)).collect();
    let art_dir = cache_dir().join("art");

    let mut entries = Vec::new();
    for (app, app_id) in apps.iter().zip(ids) {
        let Some(cmd) = app["cmd"].as_str() else { continue };
        let Some(game_id) = cmd.split(sunshine::MARKER).nth(1).map(str::trim) else { continue };
        let Some(game) = games.get(game_id) else { continue };
        let app_name = app["name"].as_str().unwrap_or_default().to_string();
        let raw = if game.launcher {
            game.title.clone()
        } else {
            // Emulator ROM titles carry " (<console>)": the category already says it.
            game.title.strip_suffix(&format!(" ({})", game.category)).unwrap_or(&game.title).to_string()
        };
        let (title, tags) = split_title(&raw);
        let cover = app["image-path"]
            .as_str()
            .map(Path::new)
            .filter(|p| p.starts_with(&art_dir))
            .and_then(|p| p.file_name())
            .map(|f| format!("/art/{}", f.to_string_lossy()));
        entries.push(Entry {
            id: game.id.clone(),
            title,
            tags,
            category: game.category.clone(),
            launcher: game.launcher,
            app_name,
            app_id,
            cover,
            achievements: ra.progress_for(game).cloned(),
        });
    }
    entries.sort_by_key(|e| (e.launcher, e.title.to_lowercase()));
    let mut categories: Vec<String> = entries.iter().map(|e| e.category.clone()).collect();
    categories.sort();
    categories.dedup();
    Ok(Library { host: host_info(), profile: ra.profile().cloned(), categories, games: entries })
}

fn host_info() -> Host {
    let dir = dirs::config_dir().unwrap_or_default().join("sunshine");
    let uuid = std::fs::read_to_string(dir.join("sunshine_state.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["root"]["uniqueid"].as_str().map(String::from))
        .unwrap_or_default();
    let name = std::fs::read_to_string(dir.join("sunshine.conf"))
        .ok()
        .and_then(|t| {
            t.lines()
                .filter_map(|l| l.split_once('='))
                .find(|(k, _)| k.trim() == "sunshine_name")
                .map(|(_, v)| v.trim().to_string())
        })
        .unwrap_or_default();
    Host { name, uuid }
}

/// `"Donkey Kong Country 2 (USA) (En,Fr)"` → `("Donkey Kong Country 2", ["USA", "En,Fr"])`.
/// Drops site watermarks; scene-style names (`G0d.of.war1`) get spaces.
pub fn split_title(raw: &str) -> (String, Vec<String>) {
    let mut title = String::new();
    let mut tags = Vec::new();
    let mut depth = 0usize;
    let mut cur = String::new();
    for c in raw.chars() {
        match c {
            '(' | '[' => {
                if depth > 0 {
                    cur.push(c);
                }
                depth += 1;
            }
            ')' | ']' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    let tag = cur.trim().to_string();
                    let noise = tag.is_empty() || tag.contains("www.") || tag.contains(".com") || tag == "!";
                    if !noise {
                        tags.push(tag);
                    }
                    cur.clear();
                } else {
                    cur.push(c);
                }
            }
            ')' | ']' => {}
            _ if depth > 0 => cur.push(c),
            _ => title.push(c),
        }
    }
    let mut title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if !title.contains(' ') && title.matches('.').count() >= 2 {
        title = title.replace('.', " ");
    }
    let title = title.trim().trim_end_matches(['-', ',', ' ']).trim().to_string();
    (if title.is_empty() { raw.trim().to_string() } else { title }, tags)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_split_into_name_and_tags() {
        assert_eq!(
            split_title("Donkey Kong Country 2 - Diddy's Kong Quest (USA) (En,Fr)"),
            ("Donkey Kong Country 2 - Diddy's Kong Quest".into(), vec!["USA".into(), "En,Fr".into()])
        );
        assert_eq!(
            split_title("Paper Mario (EMULADOR) (BR-USA) (T2.2) (www.romsportugues.com))"),
            ("Paper Mario".into(), vec!["EMULADOR".into(), "BR-USA".into(), "T2.2".into()])
        );
        assert_eq!(split_title("G0d.of.war1.pt.brv.2.1by.david.sander").0, "G0d of war1 pt brv 2 1by david sander");
        assert_eq!(split_title("Hollow Knight"), ("Hollow Knight".into(), vec![]));
        assert_eq!(split_title("(USA)").0, "(USA)");
    }
}
