//! Heroic Games Launcher: sideloaded apps and Epic (legendary) installs.
//! Launches through Heroic's `heroic://launch` URI so Heroic applies its own
//! Wine/Proton settings per game.
//!
//! Not implemented: GOG (`gog_store`) and Amazon (`nile_store`) — no installs on
//! this machine to validate the file format against.

use super::Provider;
use crate::config::Config;
use crate::model::{ArtSource, Discovery, Game, WaitSpec};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

pub struct Heroic;

#[derive(Deserialize)]
struct SideloadLibrary {
    #[serde(default)]
    games: Vec<SideloadGame>,
}

#[derive(Deserialize)]
struct SideloadGame {
    app_name: String,
    title: String,
    #[serde(default)]
    is_installed: bool,
    #[serde(default)]
    art_cover: Option<String>,
    install: Option<SideloadInstall>,
}

#[derive(Deserialize)]
struct SideloadInstall {
    executable: Option<String>,
}

#[derive(Deserialize)]
struct LegendaryInstall {
    app_name: String,
    title: String,
    #[serde(default)]
    install_path: Option<String>,
    #[serde(default)]
    executable: Option<String>,
}

impl Provider for Heroic {
    fn name(&self) -> &'static str {
        "heroic"
    }

    fn discover(&self, cfg: &Config) -> Result<Discovery> {
        let mut out = Discovery::default();
        if !cfg.heroic.enabled {
            return Ok(out);
        }
        let dir = &cfg.heroic.config_dir;
        if !dir.exists() {
            return Ok(out);
        }
        let mut candidates = Vec::new();

        let sideload = dir.join("sideload_apps/library.json");
        if sideload.exists() {
            let lib: SideloadLibrary = read_json(&sideload)?;
            for g in lib.games {
                let exe = g.install.and_then(|i| i.executable);
                match exe {
                    Some(exe) if g.is_installed && Path::new(&exe).exists() => {
                        let art = g.art_cover.as_deref().and_then(art_from_heroic);
                        candidates.push((g.app_name, g.title, "sideload", exe, art));
                    }
                    Some(exe) => out.skip("heroic", &g.title, format!("executable missing: {exe}")),
                    None => out.skip("heroic", &g.title, "no executable configured"),
                }
            }
        }

        let legendary = dir.join("legendaryConfig/legendary/installed.json");
        if legendary.exists() {
            let installed: BTreeMap<String, LegendaryInstall> = read_json(&legendary)?;
            for g in installed.into_values() {
                let exe = match (&g.install_path, &g.executable) {
                    (Some(dir), Some(exe)) => Path::new(dir).join(exe),
                    _ => {
                        out.skip("heroic", &g.title, "legendary entry without install_path/executable");
                        continue;
                    }
                };
                if !exe.exists() {
                    out.skip("heroic", &g.title, format!("executable missing: {}", exe.display()));
                    continue;
                }
                candidates.push((g.app_name, g.title, "legendary", exe.display().to_string(), None));
            }
        }

        if candidates.is_empty() {
            return Ok(out);
        }
        if !Path::new(&cfg.heroic.binary).exists() {
            for (_, title, ..) in candidates {
                out.skip("heroic", title, format!("Heroic binary not found at {}", cfg.heroic.binary));
            }
            return Ok(out);
        }
        for (app_name, title, runner, exe, art) in candidates {
            out.games.push(game_for(&cfg.heroic.binary, &app_name, &title, runner, &exe, art));
        }
        Ok(out)
    }
}

pub fn game_for(
    binary: &str,
    app_name: &str,
    title: &str,
    runner: &str,
    exe: &str,
    art: Option<ArtSource>,
) -> Game {
    let exe_name = Path::new(exe)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| exe.to_string());
    Game {
        id: format!("heroic:{app_name}"),
        title: title.to_string(),
        provider: "heroic".into(),
        category: "PC".into(),
        launcher: false,
        rom: None,
        platform: None,
        launch: vec![
            binary.to_string(),
            "--no-gui".into(),
            format!("heroic://launch?appName={app_name}&runner={runner}"),
        ],
        env: vec![],
        // Wine/Proton keeps the .exe name in the game's cmdline.
        wait: WaitSpec::Process { pattern: exe_name, start_timeout_secs: 180 },
        art,
    }
}

/// Heroic stores remote URLs or `file://` paths (the latter may point inside
/// Heroic's own bundle, which is useless to us).
fn art_from_heroic(s: &str) -> Option<ArtSource> {
    if let Some(path) = s.strip_prefix("file://") {
        let p = Path::new(path);
        return p.exists().then(|| ArtSource::File(p.to_path_buf()));
    }
    (s.starts_with("http://") || s.starts_with("https://")).then(|| ArtSource::Url(s.to_string()))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[test]
    fn sideload_with_missing_exe_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("game.exe");
        std::fs::write(&exe, b"").unwrap();
        let bin = tmp.path().join("heroic");
        std::fs::write(&bin, b"").unwrap();
        std::fs::create_dir_all(tmp.path().join("sideload_apps")).unwrap();
        let lib = serde_json::json!({ "games": [
            { "app_name": "ok1", "title": "Present", "runner": "sideload", "is_installed": true,
              "art_cover": "https://example.com/c.png", "install": { "executable": exe } },
            { "app_name": "gone", "title": "Gone", "runner": "sideload", "is_installed": true,
              "art_cover": "file:///nonexistent.jpg", "install": { "executable": "/nonexistent/x.exe" } }
        ]});
        std::fs::write(tmp.path().join("sideload_apps/library.json"), lib.to_string()).unwrap();

        let mut cfg = Config::default();
        cfg.heroic.config_dir = tmp.path().to_path_buf();
        cfg.heroic.binary = bin.display().to_string();
        let d = Heroic.discover(&cfg).unwrap();

        assert_eq!(d.games.len(), 1);
        let g = &d.games[0];
        assert_eq!(g.id, "heroic:ok1");
        assert_eq!(g.launch[2], "heroic://launch?appName=ok1&runner=sideload");
        assert_eq!(g.wait, WaitSpec::Process { pattern: "game.exe".into(), start_timeout_secs: 180 });
        assert_eq!(g.art, Some(ArtSource::Url("https://example.com/c.png".into())));
        assert_eq!(d.skipped.len(), 1);
        assert_eq!(d.skipped[0].title, "Gone");
    }

    #[test]
    fn missing_heroic_binary_skips_everything() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("game.exe");
        std::fs::write(&exe, b"").unwrap();
        std::fs::create_dir_all(tmp.path().join("sideload_apps")).unwrap();
        let lib = serde_json::json!({ "games": [
            { "app_name": "a", "title": "A", "is_installed": true, "install": { "executable": exe } }
        ]});
        std::fs::write(tmp.path().join("sideload_apps/library.json"), lib.to_string()).unwrap();
        let mut cfg = Config::default();
        cfg.heroic.config_dir = tmp.path().to_path_buf();
        cfg.heroic.binary = "/nonexistent/heroic".into();
        let d = Heroic.discover(&cfg).unwrap();
        assert!(d.games.is_empty());
        assert!(d.skipped[0].reason.contains("Heroic binary not found"));
    }
}
