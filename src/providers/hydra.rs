//! Hydra Launcher: reads the `!games!` records of its LevelDB (`hydra-db`).
//!
//! Hydra only stores an `executablePath` after the user points it at the game's
//! executable. Records without it are reported as skipped. Windows executables
//! are started with Steam's Proton (`proton run`), one compat prefix per game.
//! Untested end-to-end: no Hydra game on this machine has an executable yet.

use super::{steam, Provider};
use crate::config::{cache_dir, Config};
use crate::model::{Discovery, Game, WaitSpec};
use anyhow::{Context, Result};
use rusty_leveldb::{LdbIterator, Options, DB};
use serde::Deserialize;
use std::path::{Path, PathBuf};

pub struct Hydra;

const GAMES_PREFIX: &str = "!games!";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydraGame {
    pub title: String,
    pub shop: String,
    pub object_id: String,
    #[serde(default)]
    pub executable_path: Option<String>,
    #[serde(default)]
    pub wine_prefix_path: Option<String>,
    #[serde(default)]
    pub is_deleted: bool,
}

impl Provider for Hydra {
    fn name(&self) -> &'static str {
        "hydra"
    }

    fn discover(&self, cfg: &Config) -> Result<Discovery> {
        let mut out = Discovery::default();
        if !cfg.hydra.enabled || !cfg.hydra.db_dir.exists() {
            return Ok(out);
        }
        let proton = steam::find_proton(&cfg.steam.root);
        for g in read_games(&cfg.hydra.db_dir)? {
            if g.is_deleted {
                continue;
            }
            let Some(exe) = g.executable_path.clone() else {
                out.skip("hydra", &g.title, "no executable set in Hydra");
                continue;
            };
            if !Path::new(&exe).exists() {
                out.skip("hydra", &g.title, format!("executable missing: {exe}"));
                continue;
            }
            match game_for(cfg, &g, &exe, proton.as_deref()) {
                Some(game) => out.games.push(game),
                None => out.skip("hydra", &g.title, "Windows game but no Proton found in Steam libraries"),
            }
        }
        Ok(out)
    }
}

fn game_for(cfg: &Config, g: &HydraGame, exe: &str, proton: Option<&Path>) -> Option<Game> {
    let is_windows = exe.to_lowercase().ends_with(".exe");
    let exe_name = Path::new(exe).file_name()?.to_string_lossy().into_owned();
    let (launch, env, wait) = if is_windows {
        let proton = proton?;
        let compat = g
            .wine_prefix_path
            .as_deref()
            .map(compat_dir_from_prefix)
            .unwrap_or_else(|| cache_dir().join("compat").join(format!("hydra-{}", g.object_id)));
        let env = vec![
            ("STEAM_COMPAT_DATA_PATH".to_string(), compat.display().to_string()),
            ("STEAM_COMPAT_CLIENT_INSTALL_PATH".to_string(), cfg.steam.root.display().to_string()),
        ];
        let launch = vec![proton.display().to_string(), "run".into(), exe.to_string()];
        (launch, env, WaitSpec::Process { pattern: exe_name, start_timeout_secs: 120 })
    } else {
        (vec![exe.to_string()], vec![], WaitSpec::Child)
    };
    let art = (g.shop == "steam").then(|| steam::steam_art(&cfg.steam.root, &g.object_id));
    Some(Game {
        id: format!("hydra:{}:{}", g.shop, g.object_id),
        title: g.title.clone(),
        provider: "hydra".into(),
        category: "PC".into(),
        launcher: false,
        rom: None,
        platform: None,
        launch,
        env,
        wait,
        art,
    })
}

/// Proton wants the directory that *contains* `pfx/`.
fn compat_dir_from_prefix(prefix: &str) -> PathBuf {
    let p = Path::new(prefix);
    if p.file_name().is_some_and(|n| n == "pfx") {
        p.parent().unwrap_or(p).to_path_buf()
    } else {
        p.to_path_buf()
    }
}

/// Opens a *copy* of the DB: opening in place would take Hydra's LOCK and may
/// trigger a compaction that writes to Hydra's files.
pub fn read_games(db_dir: &Path) -> Result<Vec<HydraGame>> {
    let tmp = tempfile::tempdir()?;
    for entry in std::fs::read_dir(db_dir).with_context(|| format!("reading {}", db_dir.display()))? {
        let entry = entry?;
        if entry.file_name() == "LOCK" || !entry.file_type()?.is_file() {
            continue;
        }
        std::fs::copy(entry.path(), tmp.path().join(entry.file_name()))?;
    }
    let opts = Options { create_if_missing: false, ..Options::default() };
    let mut db = DB::open(tmp.path(), opts).map_err(|e| anyhow::anyhow!("opening hydra-db: {e}"))?;
    let mut it = db.new_iter().map_err(|e| anyhow::anyhow!("iterating hydra-db: {e}"))?;
    let mut games = Vec::new();
    while let Some((k, v)) = it.next() {
        if !k.starts_with(GAMES_PREFIX.as_bytes()) {
            continue;
        }
        match serde_json::from_slice::<HydraGame>(&v) {
            Ok(g) => games.push(g),
            Err(e) => eprintln!("hydra: skipping {}: {e}", String::from_utf8_lossy(&k)),
        }
    }
    Ok(games)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_db(dir: &Path, records: &[(&str, serde_json::Value)]) {
        let opts = Options { create_if_missing: true, ..Options::default() };
        let mut db = DB::open(dir, opts).unwrap();
        for (k, v) in records {
            db.put(k.as_bytes(), v.to_string().as_bytes()).unwrap();
        }
        db.put(b"!downloads!x", b"{}").unwrap();
        db.flush().unwrap();
    }

    #[test]
    fn reads_only_game_records() {
        let tmp = tempfile::tempdir().unwrap();
        write_db(tmp.path(), &[
            ("!games!steam:1", serde_json::json!({"title":"A","shop":"steam","objectId":"1","isDeleted":false})),
            ("!games!steam:2", serde_json::json!({"title":"B","shop":"steam","objectId":"2","isDeleted":true,
                "executablePath":"/x/b.exe"})),
        ]);
        let games = read_games(tmp.path()).unwrap();
        assert_eq!(games.len(), 2);
        assert_eq!(games[0].title, "A");
        assert!(games[0].executable_path.is_none());
        assert_eq!(games[1].executable_path.as_deref(), Some("/x/b.exe"));
    }

    #[test]
    fn windows_game_uses_proton_with_compat_dir() {
        let cfg = Config::default();
        let g = HydraGame {
            title: "G".into(),
            shop: "steam".into(),
            object_id: "42".into(),
            executable_path: None,
            wine_prefix_path: Some("/p/hydra/42/pfx".into()),
            is_deleted: false,
        };
        let game = game_for(&cfg, &g, "/games/G/G.exe", Some(Path::new("/proton/proton"))).unwrap();
        assert_eq!(game.launch, vec!["/proton/proton", "run", "/games/G/G.exe"]);
        assert!(game.env.contains(&("STEAM_COMPAT_DATA_PATH".into(), "/p/hydra/42".into())));
        assert_eq!(game.wait, WaitSpec::Process { pattern: "G.exe".into(), start_timeout_secs: 120 });
        assert!(game_for(&cfg, &g, "/games/G/G.exe", None).is_none());
    }
}
