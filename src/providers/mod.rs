//! Game sources. Each launcher is one module implementing [`Provider`].
//! To add a launcher: create a module, implement the trait, add it to [`registry`].
//! Emulators need no code: they are configured in `config.toml` (`[emulators.<key>]`).

use crate::config::Config;
use crate::model::Discovery;
use anyhow::Result;

pub mod disc;
pub mod emulator;
pub mod heroic;
pub mod hydra;
pub mod steam;

pub trait Provider {
    fn name(&self) -> &'static str;
    fn discover(&self, cfg: &Config) -> Result<Discovery>;
}

pub fn registry() -> Vec<Box<dyn Provider>> {
    vec![
        Box::new(steam::Steam),
        Box::new(heroic::Heroic),
        Box::new(hydra::Hydra),
        Box::new(emulator::Emulators),
    ]
}

/// Runs every provider, applies `[library]` exclude/rename, sorts by title.
/// A failing provider is reported as skipped instead of aborting the scan.
pub fn discover_all(cfg: &Config) -> Discovery {
    let mut all = Discovery::default();
    for p in registry() {
        match p.discover(cfg) {
            Ok(d) => {
                all.games.extend(d.games);
                all.skipped.extend(d.skipped);
            }
            Err(e) => all.skip(p.name(), "*", format!("provider failed: {e:#}")),
        }
    }
    all.games.retain(|g| !cfg.library.exclude.contains(&g.id));
    for g in &mut all.games {
        if let Some(t) = cfg.library.rename.get(&g.id) {
            g.title = t.clone();
        }
    }
    all.games.sort_by_key(|g| g.title.to_lowercase());
    all
}
