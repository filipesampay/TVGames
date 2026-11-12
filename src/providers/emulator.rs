//! Config-driven emulators: every `[emulators.<key>]` produces
//! - one "frontend" app (the emulator's own controller-friendly UI), and
//! - one app per ROM found in `rom_dirs`.
//!
//! Adding an emulator (Eden, a future Switch 2 one, ...) needs no code.

use super::{disc, Provider};
use crate::config::{Config, EmulatorCfg};
use crate::model::{ArtSource, Discovery, Game, WaitSpec};
use anyhow::Result;
use std::path::{Path, PathBuf};

pub struct Emulators;

const MAX_DEPTH: u32 = 4;

impl Provider for Emulators {
    fn name(&self) -> &'static str {
        "emulator"
    }

    fn discover(&self, cfg: &Config) -> Result<Discovery> {
        let mut out = Discovery::default();
        for (key, emu) in &cfg.emulators {
            if !emu.enabled {
                continue;
            }
            let label = if emu.name.is_empty() { key.as_str() } else { emu.name.as_str() };
            let Some(program) = emu.command.first() else {
                out.skip("emulator", label, "empty command");
                continue;
            };
            if !program_exists(program) {
                out.skip("emulator", label, format!("program not found: {program}"));
                continue;
            }
            if !emu.frontend_args.is_empty() {
                out.games.push(Game {
                    id: format!("emu:{key}"),
                    title: label.to_string(),
                    provider: "emulator".into(),
                    category: label.to_string(),
                    launcher: true,
                    rom: None,
                    platform: None,
                    launch: [emu.command.clone(), emu.frontend_args.clone()].concat(),
                    env: vec![],
                    wait: WaitSpec::Child,
                    art: emu.art.as_deref().map(art_from_str),
                });
            }
            for rom in find_roms(emu) {
                out.games.push(rom_game(key, label, emu, &rom));
            }
        }
        Ok(out)
    }
}

fn rom_game(key: &str, label: &str, emu: &EmulatorCfg, rom: &Path) -> Game {
    let stem = rom.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let rom_str = rom.display().to_string();
    let args = emu.rom_args.iter().map(|a| a.replace("{rom}", &rom_str));
    Game {
        id: format!("emu:{key}:{:016x}", fnv1a(rom_str.as_bytes())),
        title: format!("{stem} ({label})"),
        provider: "emulator".into(),
        category: label.to_string(),
        launcher: false,
        rom: Some(rom.to_path_buf()),
        platform: emu.platform.clone(),
        launch: emu.command.iter().cloned().chain(args).collect(),
        env: vec![],
        wait: WaitSpec::Child,
        art: emu
            .covers_dir
            .as_deref()
            .and_then(|d| cover_for(d, &stem))
            .or_else(|| {
                emu.thumbnails
                    .as_ref()
                    .map(|sys| ArtSource::Libretro { system: sys.clone(), name: stem.clone() })
            }),
    }
}

fn find_roms(emu: &EmulatorCfg) -> Vec<PathBuf> {
    let wanted = emu.platform.as_deref().and_then(disc::Platform::parse);
    let mut roms = Vec::new();
    for dir in &emu.rom_dirs {
        walk(dir, MAX_DEPTH, &mut |p| {
            let Some(ext) = p.extension().map(|e| e.to_string_lossy().to_lowercase()) else { return };
            if !emu.extensions.contains(&ext) {
                return;
            }
            // A .bin next to a .cue of the same name is a track, not a game.
            if ext == "bin" && emu.extensions.iter().any(|e| e == "cue") && p.with_extension("cue").exists() {
                return;
            }
            // Disc of another console (only when it can be identified).
            if let (Some(want), Some(found)) = (wanted, disc::detect(p))
                && want != found
            {
                return;
            }
            roms.push(p.to_path_buf());
        });
    }
    roms.sort();
    roms
}

fn walk(dir: &Path, depth: u32, f: &mut dyn FnMut(&Path)) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                walk(&p, depth - 1, f);
            }
        } else {
            f(&p);
        }
    }
}

fn cover_for(dir: &Path, stem: &str) -> Option<ArtSource> {
    ["png", "jpg", "jpeg", "webp"]
        .iter()
        .map(|ext| dir.join(format!("{stem}.{ext}")))
        .find(|p| p.exists())
        .map(ArtSource::File)
}

fn art_from_str(s: &str) -> ArtSource {
    if s.starts_with("http://") || s.starts_with("https://") {
        ArtSource::Url(s.to_string())
    } else {
        ArtSource::File(PathBuf::from(s))
    }
}

pub fn program_exists(program: &str) -> bool {
    if program.contains('/') {
        return Path::new(program).exists();
    }
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|d| d.join(program).is_file()))
}

/// Stable, dependency-free hash for ROM ids (FNV-1a 64).
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x100000001b3))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn emu_cfg(dir: &Path) -> EmulatorCfg {
        EmulatorCfg {
            name: "PlayStation".into(),
            command: vec!["/bin/true".into()],
            frontend_args: vec!["-bigpicture".into()],
            rom_args: vec!["-fullscreen".into(), "--".into(), "{rom}".into()],
            rom_dirs: vec![dir.to_path_buf()],
            extensions: vec!["cue".into(), "bin".into(), "chd".into()],
            covers_dir: Some(dir.join("covers")),
            ..Default::default()
        }
    }

    #[test]
    fn frontend_plus_roms_and_bin_with_cue_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::create_dir_all(d.join("covers")).unwrap();
        for f in ["Game A.cue", "Game A.bin", "sub/Game B.chd", "Lone.bin", "readme.txt", "covers/Game A.png"] {
            std::fs::write(d.join(f), b"").unwrap();
        }
        let mut cfg = Config::default();
        cfg.emulators.insert("duck".into(), emu_cfg(d));
        let out = Emulators.discover(&cfg).unwrap();
        let titles: Vec<_> = out.games.iter().map(|g| g.title.as_str()).collect();
        assert_eq!(titles, vec!["PlayStation", "Game A (PlayStation)", "Lone (PlayStation)", "Game B (PlayStation)"]);

        let a = &out.games[1];
        assert_eq!(a.launch, vec!["/bin/true".to_string(), "-fullscreen".into(), "--".into(), d.join("Game A.cue").display().to_string()]);
        assert_eq!(a.art, Some(ArtSource::File(d.join("covers/Game A.png"))));
        assert!(a.id.starts_with("emu:duck:"));
        assert_eq!(out.games[0].launch, vec!["/bin/true", "-bigpicture"]);
    }

    #[test]
    fn missing_program_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let mut e = emu_cfg(tmp.path());
        e.command = vec!["/nonexistent/emu".into()];
        let mut cfg = Config::default();
        cfg.emulators.insert("x".into(), e);
        let out = Emulators.discover(&cfg).unwrap();
        assert!(out.games.is_empty());
        assert_eq!(out.skipped.len(), 1);
    }
}
