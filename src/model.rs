//! Core data types shared by providers, the Sunshine sync and the launcher.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A playable entry discovered by a provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Game {
    /// Stable id, `"<provider>:<key>"`. Used as `tvgames launch <id>`.
    pub id: String,
    pub title: String,
    pub provider: String,
    /// Shelf on the TV: console name for emulators, "Steam"/"PC" for PC games.
    #[serde(default)]
    pub category: String,
    /// A launcher/frontend (emulator menu, Big Picture), not a single game.
    #[serde(default)]
    pub launcher: bool,
    /// ROM/disc file for emulated games (used for RetroAchievements hashing).
    #[serde(default)]
    pub rom: Option<PathBuf>,
    /// Console id for emulated games: "snes", "n64", "ps1", "ps2", ...
    #[serde(default)]
    pub platform: Option<String>,
    /// argv to spawn. `argv[0]` is resolved through `PATH`.
    pub launch: Vec<String>,
    /// Extra environment variables for the launched process.
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub wait: WaitSpec,
    #[serde(default)]
    pub art: Option<ArtSource>,
}

/// How `tvgames launch` knows the game is still running.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WaitSpec {
    /// The spawned process *is* the game (emulators, native binaries).
    Child,
    /// The spawned process only hands off to a launcher (Steam, Heroic).
    /// Wait until a process whose cmdline contains `pattern` appears, then
    /// until no such process remains.
    Process { pattern: String, start_timeout_secs: u64 },
    /// Nothing of its own to track (e.g. Big Picture inside an already running
    /// Steam): run until the stream is stopped, then run `on_stop`.
    UntilStopped { on_stop: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ArtSource {
    File(PathBuf),
    Url(String),
    /// libretro-thumbnails box art for `name` in `system`, matched by title
    /// when the exact file name does not exist.
    Libretro { system: String, name: String },
}

/// An entry a provider saw but cannot launch, reported by `tvgames scan`.
#[derive(Debug, Clone)]
pub struct Skipped {
    pub provider: String,
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Default)]
pub struct Discovery {
    pub games: Vec<Game>,
    pub skipped: Vec<Skipped>,
}

impl Discovery {
    pub fn skip(&mut self, provider: &str, title: impl Into<String>, reason: impl Into<String>) {
        self.skipped.push(Skipped {
            provider: provider.to_string(),
            title: title.into(),
            reason: reason.into(),
        });
    }
}
