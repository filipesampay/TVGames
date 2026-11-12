//! Steam: `libraryfolders.vdf` + `appmanifest_*.acf`.

use super::Provider;
use crate::config::Config;
use crate::model::{ArtSource, Discovery, Game, WaitSpec};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub struct Steam;

#[derive(Deserialize)]
struct LibraryFolder {
    path: String,
}

#[derive(Deserialize)]
struct AppState {
    appid: String,
    name: String,
    #[serde(rename = "StateFlags", default)]
    state_flags: Option<String>,
}

/// Steam "apps" that are tools, not games.
const TOOL_PREFIXES: &[&str] = &[
    "Proton",
    "Steam Linux Runtime",
    "Steamworks Common Redistributables",
    "SteamVR",
];

const STATE_FULLY_INSTALLED: u32 = 4;

impl Provider for Steam {
    fn name(&self) -> &'static str {
        "steam"
    }

    fn discover(&self, cfg: &Config) -> Result<Discovery> {
        let mut out = Discovery::default();
        if !cfg.steam.enabled {
            return Ok(out);
        }
        let root = &cfg.steam.root;
        if cfg.steam.big_picture && super::emulator::program_exists("steam") {
            out.games.push(big_picture());
        }
        for lib in library_paths(root)? {
            let apps = lib.join("steamapps");
            let Ok(entries) = std::fs::read_dir(&apps) else {
                out.skip("steam", lib.display().to_string(), "library folder not readable");
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let is_manifest = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("appmanifest_") && n.ends_with(".acf"));
                if !is_manifest {
                    continue;
                }
                match parse_manifest(&path) {
                    Ok(app) => {
                        if TOOL_PREFIXES.iter().any(|p| app.name.starts_with(p)) {
                            continue;
                        }
                        let flags: u32 = app.state_flags.as_deref().unwrap_or("0").parse().unwrap_or(0);
                        if flags & STATE_FULLY_INSTALLED == 0 {
                            out.skip("steam", &app.name, "not fully installed");
                            continue;
                        }
                        out.games.push(game_for(root, &app.appid, &app.name));
                    }
                    Err(e) => out.skip("steam", path.display().to_string(), format!("{e:#}")),
                }
            }
        }
        Ok(out)
    }
}

pub fn game_for(steam_root: &Path, appid: &str, name: &str) -> Game {
    Game {
        id: format!("steam:{appid}"),
        title: name.to_string(),
        provider: "steam".into(),
        category: "Steam".into(),
        launcher: false,
        rom: None,
        platform: None,
        // setsid: if this starts the Steam client, keep it out of Sunshine's
        // process group (Sunshine kills that group when the stream ends).
        launch: vec!["setsid".into(), "steam".into(), format!("steam://rungameid/{appid}")],
        env: vec![],
        // Steam's reaper process carries `AppId=<id>` for the game's whole lifetime.
        wait: WaitSpec::Process { pattern: format!("AppId={appid} "), start_timeout_secs: 180 },
        art: Some(steam_art(steam_root, appid)),
    }
}

/// Steam's controller UI, opened inside the running Steam client.
pub fn big_picture() -> Game {
    let icon = Path::new("/usr/share/sunshine/steam.png");
    Game {
        id: "steam:bigpicture".into(),
        title: "Steam Big Picture".into(),
        provider: "steam".into(),
        category: "Steam".into(),
        launcher: true,
        rom: None,
        platform: None,
        launch: vec!["setsid".into(), "steam".into(), "steam://open/bigpicture".into()],
        env: vec![],
        wait: WaitSpec::UntilStopped {
            on_stop: vec!["setsid".into(), "steam".into(), "steam://close/bigpicture".into()],
        },
        art: icon.exists().then(|| ArtSource::File(icon.to_path_buf())),
    }
}

/// Local library cache first, Steam CDN otherwise.
pub fn steam_art(steam_root: &Path, appid: &str) -> ArtSource {
    let dir = steam_root.join("appcache/librarycache").join(appid);
    if let Some(p) = find_file(&dir, "library_600x900", 2) {
        return ArtSource::File(p);
    }
    ArtSource::Url(format!(
        "https://shared.steamstatic.com/store_item_assets/steam/apps/{appid}/library_600x900_2x.jpg"
    ))
}

fn find_file(dir: &Path, stem: &str, depth: u32) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_file() && p.file_stem().and_then(|s| s.to_str()) == Some(stem) {
            return Some(p);
        }
        if p.is_dir() && depth > 0
            && let Some(found) = find_file(&p, stem, depth - 1) {
                return Some(found);
            }
    }
    None
}

fn library_paths(root: &Path) -> Result<Vec<PathBuf>> {
    let vdf = root.join("steamapps/libraryfolders.vdf");
    let text = std::fs::read_to_string(&vdf).with_context(|| format!("reading {}", vdf.display()))?;
    parse_library_folders(&text)
}

pub fn parse_library_folders(text: &str) -> Result<Vec<PathBuf>> {
    let folders: BTreeMap<String, LibraryFolder> =
        keyvalues_serde::from_str(text).context("parsing libraryfolders.vdf")?;
    Ok(folders.into_values().map(|f| PathBuf::from(f.path)).collect())
}

fn parse_manifest(path: &Path) -> Result<AppState> {
    let text = std::fs::read_to_string(path)?;
    parse_manifest_str(&text)
}

fn parse_manifest_str(text: &str) -> Result<AppState> {
    keyvalues_serde::from_str(text).context("parsing appmanifest")
}

/// Newest Proton found in any Steam library (prefers Experimental).
pub fn find_proton(steam_root: &Path) -> Option<PathBuf> {
    let libs = library_paths(steam_root).unwrap_or_else(|_| vec![steam_root.to_path_buf()]);
    let mut found: Vec<PathBuf> = Vec::new();
    for lib in libs {
        let Ok(entries) = std::fs::read_dir(lib.join("steamapps/common")) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let script = e.path().join("proton");
            if name.starts_with("Proton") && script.exists() {
                found.push(script);
            }
        }
    }
    found.sort_by_key(|p| {
        let n = p.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().into_owned());
        (!n.as_deref().unwrap_or("").contains("Experimental"), std::cmp::Reverse(n))
    });
    found.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIBRARY: &str = r#""libraryfolders"
{
	"0"
	{
		"path"		"/home/filipe/.local/share/Steam"
		"label"		""
		"contentid"		"7331325652354277341"
		"apps"
		{
			"1493710"		"1537210305"
		}
	}
	"1"
	{
		"path"		"/games/SteamLibrary"
		"label"		""
		"apps"
		{
		}
	}
}"#;

    const MANIFEST: &str = r#""AppState"
{
	"appid"		"1493710"
	"Universe"		"1"
	"name"		"Proton Experimental"
	"StateFlags"		"4"
	"installdir"		"Proton - Experimental"
	"UserConfig"
	{
		"language"		"english"
	}
}"#;

    #[test]
    fn parses_library_folders() {
        let paths = parse_library_folders(LIBRARY).unwrap();
        assert_eq!(
            paths,
            vec![PathBuf::from("/home/filipe/.local/share/Steam"), PathBuf::from("/games/SteamLibrary")]
        );
    }

    #[test]
    fn parses_manifest() {
        let app = parse_manifest_str(MANIFEST).unwrap();
        assert_eq!(app.appid, "1493710");
        assert_eq!(app.name, "Proton Experimental");
        assert_eq!(app.state_flags.as_deref(), Some("4"));
    }

    #[test]
    fn game_waits_on_exact_appid() {
        let g = game_for(Path::new("/nonexistent"), "570", "Dota 2");
        assert_eq!(g.wait, WaitSpec::Process { pattern: "AppId=570 ".into(), start_timeout_secs: 180 });
        assert_eq!(g.launch, vec!["setsid", "steam", "steam://rungameid/570"]);
    }
}
