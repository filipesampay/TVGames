//! `~/.config/tvgames/config.toml`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Config {
    pub sunshine: SunshineCfg,
    pub display: DisplayCfg,
    pub tv: TvCfg,
    pub library: LibraryCfg,
    pub art: ArtCfg,
    pub steam: SteamCfg,
    pub heroic: HeroicCfg,
    pub hydra: HydraCfg,
    pub hotkey: HotkeyCfg,
    pub retroachievements: RetroAchievementsCfg,
    /// One entry per emulator; the key becomes part of the game id.
    pub emulators: BTreeMap<String, EmulatorCfg>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SunshineCfg {
    pub url: String,
    pub username: String,
    pub password: String,
}

impl Default for SunshineCfg {
    fn default() -> Self {
        Self {
            url: "https://localhost:47990".into(),
            username: "filipe".into(),
            password: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DisplayCfg {
    /// Output that Sunshine captures (`output_name` in sunshine.conf).
    pub output: String,
    /// kscreen-doctor mode applied to `output` during a session.
    pub mode: String,
    /// Make `output` the primary display during a session (XWayland/Wine use it).
    pub make_primary: bool,
    /// During a session, move every newly opened window to `output` (KWin script).
    pub move_new_windows: bool,
}

impl Default for DisplayCfg {
    fn default() -> Self {
        Self {
            output: "HDMI-A-1".into(),
            mode: "1920x1080@60".into(),
            make_primary: true,
            move_new_windows: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TvCfg {
    /// `adb -s` serial of the TV.
    pub adb_serial: String,
}

impl Default for TvCfg {
    fn default() -> Self {
        Self { adb_serial: "192.168.50.149:5555".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RetroAchievementsCfg {
    pub username: String,
    /// Login token from `tvgames cheevos login` (the password is never stored).
    pub token: String,
    /// "Web API Key" from the RetroAchievements control panel (progress on the TV).
    pub web_api_key: String,
    /// Hardcore: more points, but no save states/cheats/slow motion.
    pub hardcore: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HotkeyCfg {
    /// Close the running app when `buttons` are held together on the TV controller.
    pub enabled: bool,
    /// Button names: a b x y lb rb select start guide l3 r3.
    pub buttons: Vec<String>,
    pub hold_ms: u64,
    /// Only gamepads whose name contains this (Sunshine's virtual pads).
    pub device_match: String,
}

impl Default for HotkeyCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            buttons: vec!["select".into(), "start".into()],
            hold_ms: 1000,
            device_match: "Sunshine".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct LibraryCfg {
    /// Game ids to hide (e.g. `"heroic:s46gDwWneUMqx3Cxie1Fb1"`).
    pub exclude: Vec<String>,
    /// Display-name overrides: id -> title.
    pub rename: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ArtCfg {
    /// Optional SteamGridDB API key, used for titles without art.
    pub steamgriddb_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SteamCfg {
    pub enabled: bool,
    pub root: PathBuf,
    /// Publish a "Steam Big Picture" app.
    pub big_picture: bool,
}

impl Default for SteamCfg {
    fn default() -> Self {
        Self { enabled: true, root: home().join(".local/share/Steam"), big_picture: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HeroicCfg {
    pub enabled: bool,
    pub config_dir: PathBuf,
    /// Heroic binary (handles `heroic://` URIs).
    pub binary: String,
}

impl Default for HeroicCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            config_dir: home().join(".config/heroic"),
            binary: "/opt/Heroic/heroic".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HydraCfg {
    pub enabled: bool,
    pub db_dir: PathBuf,
}

impl Default for HydraCfg {
    fn default() -> Self {
        Self { enabled: true, db_dir: home().join(".config/hydralauncher/hydra-db") }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EmulatorCfg {
    pub enabled: bool,
    /// Human name, e.g. "PlayStation 2". Used as prefix for ROM titles.
    pub name: String,
    /// Base command, e.g. `["flatpak", "run", "net.pcsx2.PCSX2"]`.
    pub command: Vec<String>,
    /// Args for the "frontend" app (emulator UI navigable with a controller).
    /// Empty = no frontend app.
    pub frontend_args: Vec<String>,
    /// Args to boot a ROM; `{rom}` is replaced with the file path.
    pub rom_args: Vec<String>,
    pub rom_dirs: Vec<PathBuf>,
    /// Lowercase file extensions without dot.
    pub extensions: Vec<String>,
    /// Optional cover image for the frontend app (path or URL).
    pub art: Option<String>,
    /// Folder with ROM covers named after the ROM file (`<stem>.png|jpg|webp`).
    pub covers_dir: Option<PathBuf>,
    /// `"ps1"` / `"ps2"`: discs identified as another console are ignored
    /// (lets PCSX2 and DuckStation share one mixed ROM folder).
    pub platform: Option<String>,
    /// libretro-thumbnails system name (e.g. "Nintendo - Super Nintendo
    /// Entertainment System"): box art is fetched by ROM file name.
    pub thumbnails: Option<String>,
}

impl Default for EmulatorCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            name: String::new(),
            command: Vec::new(),
            frontend_args: Vec::new(),
            rom_args: vec!["{rom}".into()],
            rom_dirs: Vec::new(),
            extensions: Vec::new(),
            art: None,
            covers_dir: None,
            platform: None,
            thumbnails: None,
        }
    }
}

pub fn home() -> PathBuf {
    dirs::home_dir().expect("HOME not set")
}

pub fn config_path() -> PathBuf {
    dirs::config_dir().expect("no config dir").join("tvgames/config.toml")
}

pub fn cache_dir() -> PathBuf {
    dirs::cache_dir().expect("no cache dir").join("tvgames")
}

impl Config {
    pub fn load() -> Result<Self> {
        Self::load_from(&config_path())
    }

    pub fn load_from(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::with_default_emulators());
        }
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading {}", path.display()))?;
        toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }

    /// Defaults plus the emulators found on this machine.
    pub fn with_default_emulators() -> Self {
        let mut cfg = Self::default();
        cfg.emulators.insert(
            "pcsx2".into(),
            EmulatorCfg {
                name: "PlayStation 2".into(),
                command: vec!["flatpak".into(), "run".into(), "net.pcsx2.PCSX2".into()],
                frontend_args: vec!["-bigpicture".into(), "-fullscreen".into()],
                rom_args: vec!["-fullscreen".into(), "-nogui".into(), "--".into(), "{rom}".into()],
                extensions: ["iso", "chd", "cso", "zso", "gz", "cue", "bin", "elf"].map(String::from).to_vec(),
                platform: Some("ps2".into()),
                thumbnails: Some("Sony - PlayStation 2".into()),
                ..Default::default()
            },
        );
        cfg.emulators.insert(
            "duckstation".into(),
            EmulatorCfg {
                name: "PlayStation".into(),
                command: vec![home().join("Applications/duckstation.AppImage").display().to_string()],
                frontend_args: vec!["-bigpicture".into(), "-fullscreen".into()],
                rom_args: vec!["-fullscreen".into(), "-nogui".into(), "--".into(), "{rom}".into()],
                extensions: ["cue", "chd", "pbp", "m3u", "iso", "bin", "ecm", "mds"].map(String::from).to_vec(),
                platform: Some("ps1".into()),
                thumbnails: Some("Sony - PlayStation".into()),
                ..Default::default()
            },
        );
        let retroarch = || vec!["flatpak".to_string(), "run".into(), "org.libretro.RetroArch".into()];
        let cores = home().join(".var/app/org.libretro.RetroArch/config/retroarch/cores");
        let core_args = |core: &str| {
            vec!["-f".to_string(), "-L".into(), cores.join(format!("{core}_libretro.so")).display().to_string(), "{rom}".into()]
        };
        cfg.emulators.insert(
            "retroarch".into(),
            EmulatorCfg { name: "RetroArch".into(), command: retroarch(), frontend_args: vec!["-f".into()], ..Default::default() },
        );
        cfg.emulators.insert(
            "snes".into(),
            EmulatorCfg {
                name: "Super Nintendo".into(),
                command: retroarch(),
                rom_args: core_args("snes9x"),
                rom_dirs: vec!["/games/Roms/snes".into()],
                extensions: ["sfc", "smc", "fig", "swc", "bs", "zip", "7z"].map(String::from).to_vec(),
                thumbnails: Some("Nintendo - Super Nintendo Entertainment System".into()),
                platform: Some("snes".into()),
                ..Default::default()
            },
        );
        cfg.emulators.insert(
            "n64".into(),
            EmulatorCfg {
                name: "Nintendo 64".into(),
                command: retroarch(),
                rom_args: core_args("mupen64plus_next"),
                rom_dirs: vec!["/games/Roms/n64".into()],
                extensions: ["z64", "n64", "v64", "zip", "7z"].map(String::from).to_vec(),
                thumbnails: Some("Nintendo - Nintendo 64".into()),
                platform: Some("n64".into()),
                ..Default::default()
            },
        );
        cfg
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = toml::to_string_pretty(self)?;
        std::fs::write(path, text)?;
        // Contains the Sunshine password.
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(())
    }
}
