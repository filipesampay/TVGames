//! RetroAchievements: ROM hashing (same algorithms as rcheevos), login, emulator
//! configuration and progress for the TV app.
//!
//! - Hashes: rcheevos `src/hash/rc_hash_rom.c` (SNES, N64) and
//!   `src/hash/rc_hash_disc.c` (PS1, PS2).
//! - Connect API (`/dorequest.php`, `r=login2` / `r=gameid`): rcheevos `src/api`.
//! - Web API (`/API/*.php?y=<key>`): api-docs.retroachievements.org.

use crate::config::{cache_dir, home, Config, RetroAchievementsCfg};
use crate::model::Game;
use crate::providers::disc::Disc;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const HOST: &str = "https://retroachievements.org";
const MEDIA: &str = "https://media.retroachievements.org";
const USER_AGENT: &str = "tvgames/0.1 (rcheevos-compatible hashing)";
/// rcheevos `MAX_BUFFER_SIZE`.
const MAX_HASH: usize = 64 * 1024 * 1024;
/// How long cached progress is considered fresh.
const PROGRESS_TTL: u64 = 10 * 60;
/// Badges sent to the TV per game.
const MAX_BADGES: usize = 12;

// ---------------------------------------------------------------- hashing --

/// RetroAchievements hash of a ROM/disc, or `None` if the platform is not
/// supported or the file is not recognized.
pub fn rom_hash(path: &Path, platform: &str) -> Option<String> {
    match platform {
        "snes" => hash_snes(&load_rom(path, &["sfc", "smc", "fig", "swc", "bs"])?),
        "n64" => hash_n64(&load_rom(path, &["z64", "n64", "v64", "ndd"])?),
        "ps1" => hash_playstation(path, false),
        "ps2" => hash_playstation(path, true),
        _ => None,
    }
}

fn md5_hex(parts: &[&[u8]]) -> String {
    use md5::Digest;
    let mut h = md5::Md5::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// File contents; for `.zip`, the first entry with one of `exts` (what
/// RetroArch hands to the core).
fn load_rom(path: &Path, exts: &[&str]) -> Option<Vec<u8>> {
    let is_zip = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    if !is_zip {
        return std::fs::read(path).ok();
    }
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).ok()?).ok()?;
    let names: Vec<String> = zip.file_names().filter_map(|n| n.ok().map(|c| c.into_owned())).collect();
    let pick = names
        .iter()
        .find(|n| {
            Path::new(n).extension().is_some_and(|e| exts.iter().any(|x| e.eq_ignore_ascii_case(x)))
        })
        .or_else(|| names.first())?
        .clone();
    let mut entry = zip.by_name(&pick).ok()?;
    let mut data = Vec::new();
    entry.read_to_end(&mut data).ok()?;
    Some(data)
}

/// `rc_hash_snes`: skip a 512-byte copier header if present.
fn hash_snes(data: &[u8]) -> Option<String> {
    let body = if data.len() % 0x2000 == 512 { &data[512..] } else { data };
    Some(md5_hex(&[&body[..body.len().min(MAX_HASH)]]))
}

/// `rc_hash_n64`: hash in big-endian (.z64) byte order.
fn hash_n64(data: &[u8]) -> Option<String> {
    let mut buf = data[..data.len().min(MAX_HASH)].to_vec();
    match *buf.first()? {
        0x80 | 0xE8 | 0x22 => {}
        0x37 => buf.as_chunks_mut::<2>().0.iter_mut().for_each(|c| c.swap(0, 1)),
        0x40 => buf.as_chunks_mut::<4>().0.iter_mut().for_each(|c| c.reverse()),
        _ => return None,
    }
    Some(md5_hex(&[&buf]))
}

/// `rc_hash_psx` / `rc_hash_ps2`: md5(boot executable name + its contents).
fn hash_playstation(path: &Path, ps2: bool) -> Option<String> {
    let mut disc = Disc::open(path)?;
    let cnf = disc.system_cnf();
    let (key, prefix) = if ps2 { ("BOOT2", "cdrom0:") } else { ("BOOT", "cdrom:") };
    let mut name = cnf.as_deref().and_then(|c| boot_exe(c, key, prefix));
    let mut found = name.as_deref().and_then(|n| disc.find_file(n));
    if found.is_none() && !ps2 {
        found = disc.find_file("PSX.EXE");
        name = found.map(|_| "PSX.EXE".to_string());
    }
    let (lba, mut size) = found?;
    let name = name?;
    if !ps2 {
        // The PS-X EXE header stores the size (without the 2048-byte header) at offset 28.
        let head = disc.sector(lba)?;
        if &head[..7] == b"PS-X EX" {
            size = u32::from_le_bytes([head[28], head[29], head[30], head[31]]) + 2048;
        }
    }
    let contents = disc.read_file(lba, size.min(MAX_HASH as u32));
    Some(md5_hex(&[name.as_bytes(), &contents]))
}

/// Boot executable from SYSTEM.CNF, parsed exactly like
/// `rc_hash_find_playstation_executable` (keys only at line starts,
/// case-sensitive `cdrom:` prefix, name ends at whitespace or `;`).
pub fn boot_exe(cnf: &[u8], key: &str, prefix: &str) -> Option<String> {
    let end = cnf.iter().position(|b| *b == 0).unwrap_or(cnf.len());
    let text = &cnf[..end];
    let mut pos = 0;
    while pos < text.len() {
        let line_end = text[pos..].iter().position(|b| *b == b'\n').map_or(text.len(), |i| pos + i);
        let line = &text[pos..line_end];
        if let Some(rest) = line.strip_prefix(key.as_bytes()) {
            let rest = trim_ascii_start(rest);
            if let Some(rest) = rest.strip_prefix(b"=") {
                let mut rest = trim_ascii_start(rest);
                if let Some(r) = rest.strip_prefix(prefix.as_bytes()) {
                    rest = r;
                }
                while let Some(r) = rest.strip_prefix(b"\\") {
                    rest = r;
                }
                let len = rest.iter().position(|b| b.is_ascii_whitespace() || *b == b';').unwrap_or(rest.len()).min(63);
                return Some(String::from_utf8_lossy(&rest[..len]).into_owned());
            }
        }
        pos = line_end + 1;
    }
    None
}

fn trim_ascii_start(mut s: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = s {
        if first.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    s
}

// -------------------------------------------------------------------- API --

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Badge {
    pub title: String,
    pub description: String,
    pub points: u32,
    pub url: String,
    pub earned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GameProgress {
    pub game_id: u64,
    pub total: u32,
    pub earned: u32,
    pub earned_hardcore: u32,
    pub badges: Vec<Badge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Profile {
    pub user: String,
    pub points: u64,
    pub softcore_points: u64,
    pub avatar: String,
}

pub struct Client {
    http: reqwest::blocking::Client,
}

impl Client {
    pub fn new() -> Result<Self> {
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(USER_AGENT)
            .build()?;
        Ok(Self { http })
    }

    fn dorequest(&self, form: &[(&str, &str)]) -> Result<serde_json::Value> {
        let v: serde_json::Value = self.http.post(format!("{HOST}/dorequest.php")).form(form).send()?.json()?;
        if v["Success"] == false {
            bail!("RetroAchievements: {}", v["Error"].as_str().unwrap_or("request failed"));
        }
        Ok(v)
    }

    /// Exchanges the password for a login token (the password is not kept).
    pub fn login(&self, user: &str, password: &str) -> Result<(String, String)> {
        let v = self.dorequest(&[("r", "login2"), ("u", user), ("p", password)])?;
        let token = v["Token"].as_str().context("no token in login response")?.to_string();
        let user = v["User"].as_str().unwrap_or(user).to_string();
        Ok((user, token))
    }

    /// RetroAchievements game id for a hash; 0 when the hash is unknown.
    pub fn game_id(&self, hash: &str) -> Result<u64> {
        let v = self.dorequest(&[("r", "gameid"), ("m", hash)])?;
        Ok(v["GameID"].as_u64().unwrap_or(0))
    }

    fn web(&self, endpoint: &str, cfg: &RetroAchievementsCfg, extra: &[(&str, String)]) -> Result<serde_json::Value> {
        if cfg.web_api_key.is_empty() {
            bail!("retroachievements.web_api_key is not set");
        }
        let mut q: Vec<(&str, String)> = vec![("u", cfg.username.clone()), ("y", cfg.web_api_key.clone())];
        q.extend(extra.iter().cloned());
        let resp = self.http.get(format!("{HOST}/API/{endpoint}")).query(&q).send()?;
        if !resp.status().is_success() {
            bail!("RetroAchievements Web API {endpoint}: HTTP {}", resp.status());
        }
        Ok(resp.json()?)
    }

    pub fn game_progress(&self, cfg: &RetroAchievementsCfg, game_id: u64) -> Result<GameProgress> {
        let v = self.web("API_GetGameInfoAndUserProgress.php", cfg, &[("g", game_id.to_string())])?;
        Ok(parse_progress(game_id, &v))
    }

    pub fn profile(&self, cfg: &RetroAchievementsCfg) -> Result<Profile> {
        let v = self.web("API_GetUserProfile.php", cfg, &[])?;
        Ok(Profile {
            user: v["User"].as_str().unwrap_or(&cfg.username).to_string(),
            points: v["TotalPoints"].as_u64().unwrap_or(0),
            softcore_points: v["TotalSoftcorePoints"].as_u64().unwrap_or(0),
            avatar: v["UserPic"].as_str().map(|p| format!("{MEDIA}{p}")).unwrap_or_default(),
        })
    }
}

/// Earned badges first (most recent first), then locked ones in display order.
pub fn parse_progress(game_id: u64, v: &serde_json::Value) -> GameProgress {
    let mut list: Vec<(bool, String, i64, Badge)> = v["Achievements"]
        .as_object()
        .map(|m| {
            m.values()
                .map(|a| {
                    let date = a["DateEarned"].as_str().unwrap_or("").to_string();
                    let earned = !date.is_empty();
                    let badge = a["BadgeName"].as_str().unwrap_or("00000");
                    let url = if earned {
                        format!("{MEDIA}/Badge/{badge}.png")
                    } else {
                        format!("{MEDIA}/Badge/{badge}_lock.png")
                    };
                    let order = a["DisplayOrder"].as_i64().unwrap_or(0);
                    (
                        earned,
                        date,
                        order,
                        Badge {
                            title: a["Title"].as_str().unwrap_or("").to_string(),
                            description: a["Description"].as_str().unwrap_or("").to_string(),
                            points: a["Points"].as_u64().unwrap_or(0) as u32,
                            url,
                            earned,
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    list.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
    GameProgress {
        game_id,
        total: v["NumAchievements"].as_u64().unwrap_or(list.len() as u64) as u32,
        earned: v["NumAwardedToUser"].as_u64().unwrap_or(0) as u32,
        earned_hardcore: v["NumAwardedToUserHardcore"].as_u64().unwrap_or(0) as u32,
        badges: list.into_iter().take(MAX_BADGES).map(|(.., b)| b).collect(),
    }
}

// ------------------------------------------------------- emulator configs --

/// Writes the login into RetroArch, DuckStation and PCSX2. Emulators that are
/// running are skipped (they rewrite their config on exit).
pub fn apply_to_emulators(cfg: &RetroAchievementsCfg) -> Result<Vec<String>> {
    if cfg.username.is_empty() || cfg.token.is_empty() {
        bail!("not logged in: run `tvgames cheevos login --user <name>` first");
    }
    let hardcore = if cfg.hardcore { "true" } else { "false" };
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs().to_string();
    let mut report = Vec::new();

    let ra = home().join(".var/app/org.libretro.RetroArch/config/retroarch/retroarch.cfg");
    report.push(apply_one("RetroArch", "retroarch", &ra, |p| {
        set_retroarch_cfg(
            p,
            &[
                ("cheevos_enable", "true"),
                ("cheevos_username", &cfg.username),
                ("cheevos_token", &cfg.token),
                ("cheevos_password", ""),
                ("cheevos_hardcore_mode_enable", hardcore),
            ],
        )
    }));

    let duck = home().join(".local/share/duckstation/settings.ini");
    let machine_id = std::fs::read("/etc/machine-id").unwrap_or_default();
    let encrypted = duckstation_token(&cfg.token, &cfg.username, &machine_id);
    report.push(apply_one("DuckStation", "duckstation", &duck, |p| {
        set_ini(
            p,
            "Cheevos",
            &[
                ("Enabled", "true"),
                ("Username", &cfg.username),
                ("Token", &encrypted),
                ("LoginTimestamp", &now),
                ("ChallengeMode", hardcore),
            ],
        )
    }));

    // PCSX2 moves a plain Token from PCSX2.ini into its secrets store on start.
    let pcsx2 = home().join(".var/app/net.pcsx2.PCSX2/config/PCSX2/inis/PCSX2.ini");
    report.push(apply_one("PCSX2", "pcsx2-qt", &pcsx2, |p| {
        set_ini(
            p,
            "Achievements",
            &[
                ("Enabled", "true"),
                ("Username", &cfg.username),
                ("Token", &cfg.token),
                ("LoginTimestamp", &now),
                ("ChallengeMode", hardcore),
            ],
        )
    }));
    Ok(report)
}

fn apply_one(name: &str, process: &str, path: &Path, write: impl Fn(&Path) -> Result<()>) -> String {
    if !path.exists() {
        return format!("{name}: config não encontrada ({})", path.display());
    }
    if !crate::launch::matching_pids(process).is_empty() {
        return format!("{name}: está aberto, feche e rode `tvgames cheevos apply`");
    }
    let backup = path.with_extension(format!(
        "{}.bak-cheevos",
        path.extension().and_then(|e| e.to_str()).unwrap_or("cfg")
    ));
    if !backup.exists() {
        let _ = std::fs::copy(path, &backup);
    }
    match write(path) {
        Ok(()) => format!("{name}: ok"),
        Err(e) => format!("{name}: erro: {e:#}"),
    }
}

/// Sets `key = value` lines in `[section]` of an INI (removing duplicates of
/// those keys); creates the section if missing.
pub fn set_ini(path: &Path, section: &str, kv: &[(&str, &str)]) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    std::fs::write(path, set_ini_text(&text, section, kv))?;
    Ok(())
}

pub fn set_ini_text(text: &str, section: &str, kv: &[(&str, &str)]) -> String {
    let header = format!("[{section}]");
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    let key_of = |l: &str| l.split_once('=').map(|(k, _)| k.trim().to_string());
    let new_lines: Vec<String> = kv.iter().map(|(k, v)| format!("{k} = {v}")).collect();
    match lines.iter().position(|l| l.trim() == header) {
        Some(start) => {
            let end = lines[start + 1..].iter().position(|l| l.trim_start().starts_with('[')).map_or(lines.len(), |i| start + 1 + i);
            let mut body: Vec<String> = lines[start + 1..end]
                .iter()
                .filter(|l| key_of(l).is_none_or(|k| !kv.iter().any(|(key, _)| *key == k)))
                .cloned()
                .collect();
            let trailing_blank = body.iter().rev().take_while(|l| l.trim().is_empty()).count();
            let insert_at = body.len() - trailing_blank;
            body.splice(insert_at..insert_at, new_lines);
            lines.splice(start + 1..end, body);
        }
        None => {
            if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push(header);
            lines.extend(new_lines);
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// RetroArch `key = "value"` lines: replace or append.
fn set_retroarch_cfg(path: &Path, kv: &[(&str, &str)]) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    for (k, v) in kv {
        let line = format!("{k} = \"{v}\"");
        match lines.iter().position(|l| l.split_once('=').is_some_and(|(key, _)| key.trim() == *k)) {
            Some(i) => lines[i] = line,
            None => lines.push(line),
        }
    }
    std::fs::write(path, lines.join("\n") + "\n")?;
    Ok(())
}

/// DuckStation's encrypted `Token` (src/core/achievements.cpp,
/// `EncryptLoginToken`): AES-128-CBC, key/IV = halves of
/// SHA256^101(machine-id + username), zero padding, base64.
pub fn duckstation_token(token: &str, username: &str, machine_id: &[u8]) -> String {
    use aes::cipher::{BlockCipherEncrypt, KeyInit};
    use base64::Engine;
    use sha2::Digest;

    let mut key: [u8; 32] = {
        let mut d = sha2::Sha256::new();
        d.update(machine_id);
        d.update(username.as_bytes());
        d.finalize().into()
    };
    for _ in 0..100 {
        key = sha2::Sha256::digest(key).into();
    }
    let cipher = aes::Aes128::new_from_slice(&key[..16]).expect("16-byte key");
    let mut data = token.as_bytes().to_vec();
    data.resize(data.len().div_ceil(16) * 16, 0);
    let mut prev: [u8; 16] = key[16..32].try_into().expect("16-byte iv");
    for chunk in data.as_chunks_mut::<16>().0 {
        for (b, p) in chunk.iter_mut().zip(prev) {
            *b ^= p;
        }
        cipher.encrypt_block(chunk.into());
        prev = *chunk;
    }
    base64::engine::general_purpose::STANDARD.encode(&data)
}

// ------------------------------------------------------------ cache/state --

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HashEntry {
    size: u64,
    mtime: u64,
    hash: Option<String>,
    game_id: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Cache {
    /// By ROM path.
    hashes: HashMap<String, HashEntry>,
    /// By RetroAchievements game id: (fetched_at, progress).
    progress: HashMap<u64, (u64, GameProgress)>,
    profile: Option<(u64, Profile)>,
}

impl Cache {
    pub fn progress_for(&self, game: &Game) -> Option<&GameProgress> {
        let rom = game.rom.as_ref()?.display().to_string();
        let id = self.hashes.get(&rom)?.game_id;
        self.progress.get(&id).map(|(_, p)| p)
    }

    pub fn game_id_for(&self, game: &Game) -> Option<(Option<String>, u64)> {
        let e = self.hashes.get(&game.rom.as_ref()?.display().to_string())?;
        Some((e.hash.clone(), e.game_id))
    }

    pub fn profile(&self) -> Option<&Profile> {
        self.profile.as_ref().map(|(_, p)| p)
    }
}

fn cache_path() -> PathBuf {
    cache_dir().join("retroachievements.json")
}

fn dirty_path() -> PathBuf {
    cache_dir().join("retroachievements.dirty")
}

pub fn load_cache() -> Cache {
    std::fs::read_to_string(cache_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_cache(c: &Cache) -> Result<()> {
    std::fs::create_dir_all(cache_dir())?;
    let tmp = cache_path().with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(c)?)?;
    std::fs::rename(tmp, cache_path())?;
    Ok(())
}

/// Called when a session ends: progress may have changed.
pub fn mark_dirty() {
    let _ = std::fs::create_dir_all(cache_dir());
    let _ = std::fs::write(dirty_path(), b"");
}

pub fn take_dirty() -> bool {
    std::fs::remove_file(dirty_path()).is_ok()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Hashes new/changed ROMs, resolves game ids and refreshes stale progress
/// (all when `force`). Network errors are logged, not fatal.
pub fn refresh(cfg: &Config, games: &[Game], force: bool) -> Cache {
    let mut cache = load_cache();
    let Ok(client) = Client::new() else { return cache };
    let ra = &cfg.retroachievements;
    let mut ids = Vec::new();

    for g in games {
        let (Some(rom), Some(platform)) = (&g.rom, &g.platform) else { continue };
        let Ok(meta) = std::fs::metadata(rom) else { continue };
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
        let key = rom.display().to_string();
        let fresh = cache.hashes.get(&key).is_some_and(|e| e.size == meta.len() && e.mtime == mtime);
        if !fresh {
            let hash = rom_hash(rom, platform);
            let game_id = match &hash {
                Some(h) => match client.game_id(h) {
                    Ok(id) => id,
                    Err(e) => {
                        eprintln!("cheevos: {}: {e:#}", g.title);
                        continue; // retry next time
                    }
                },
                None => 0,
            };
            cache.hashes.insert(key.clone(), HashEntry { size: meta.len(), mtime, hash, game_id });
        }
        let id = cache.hashes[&key].game_id;
        if id > 0 {
            ids.push(id);
        }
    }

    if !ra.web_api_key.is_empty() && !ra.username.is_empty() {
        ids.sort();
        ids.dedup();
        for id in ids {
            let stale = cache.progress.get(&id).is_none_or(|(t, _)| now() - t > PROGRESS_TTL);
            if force || stale {
                match client.game_progress(ra, id) {
                    Ok(p) => {
                        cache.progress.insert(id, (now(), p));
                    }
                    Err(e) => eprintln!("cheevos: progress {id}: {e:#}"),
                }
            }
        }
        let stale = cache.profile.as_ref().is_none_or(|(t, _)| now() - t > PROGRESS_TTL);
        if force || stale {
            match client.profile(ra) {
                Ok(p) => cache.profile = Some((now(), p)),
                Err(e) => eprintln!("cheevos: profile: {e:#}"),
            }
        }
    }
    if let Err(e) = save_cache(&cache) {
        eprintln!("cheevos: saving cache: {e:#}");
    }
    cache
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_exe_follows_rcheevos_parsing() {
        assert_eq!(boot_exe(b"BOOT = cdrom:\\SCUS_949.00;1\r\nTCB = 4\r\n", "BOOT", "cdrom:").as_deref(), Some("SCUS_949.00"));
        assert_eq!(boot_exe(b"BOOT2 = cdrom0:\\SCUS_973.99;1\nVER = 1.00\n", "BOOT2", "cdrom0:").as_deref(), Some("SCUS_973.99"));
        // subdirectory, no version suffix
        assert_eq!(boot_exe(b"BOOT=cdrom:\\GAME\\MAIN.EXE\n", "BOOT", "cdrom:").as_deref(), Some("GAME\\MAIN.EXE"));
        // PS1 key must not match a BOOT2 line
        assert_eq!(boot_exe(b"BOOT2 = cdrom0:\\X;1\n", "BOOT", "cdrom:"), None);
        // key only at line start
        assert_eq!(boot_exe(b"VER = BOOT = x\n", "BOOT", "cdrom:"), None);
    }

    #[test]
    fn snes_header_is_skipped() {
        let rom = vec![7u8; 0x2000 * 4];
        let mut headered = vec![0u8; 512];
        headered.extend_from_slice(&rom);
        assert_eq!(hash_snes(&headered), hash_snes(&rom));
        assert_eq!(hash_snes(&rom).unwrap(), md5_hex(&[&rom]));
    }

    #[test]
    fn n64_byte_orders_hash_the_same() {
        let z64 = vec![0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4];
        let v64 = vec![0x37, 0x80, 0x40, 0x12, 2, 1, 4, 3];
        let n64 = vec![0x40, 0x12, 0x37, 0x80, 4, 3, 2, 1];
        let h = hash_n64(&z64).unwrap();
        assert_eq!(hash_n64(&v64).unwrap(), h);
        assert_eq!(hash_n64(&n64).unwrap(), h);
        assert_eq!(hash_n64(&[0x12, 0, 0, 0]), None);
    }

    #[test]
    fn md5_matches_known_vector() {
        assert_eq!(md5_hex(&[b"abc"]), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn ini_keys_are_replaced_inside_the_section() {
        let text = "[Main]\nA = 1\n\n[Cheevos]\nEnabled = false\nToken = old\nToken = dup\nOther = x\n\n[Pad1]\nUp = Keyboard/Up\n";
        let out = set_ini_text(text, "Cheevos", &[("Enabled", "true"), ("Token", "T")]);
        assert_eq!(
            out,
            "[Main]\nA = 1\n\n[Cheevos]\nOther = x\nEnabled = true\nToken = T\n\n[Pad1]\nUp = Keyboard/Up\n"
        );
        let added = set_ini_text("[Main]\nA = 1\n", "Achievements", &[("Enabled", "true")]);
        assert_eq!(added, "[Main]\nA = 1\n\n[Achievements]\nEnabled = true\n");
    }

    #[test]
    fn duckstation_token_is_aes_cbc_base64_of_padded_token() {
        let enc = duckstation_token("abcdefghijklmnop", "user", b"0123456789abcdef0123456789abcdef\n");
        use base64::Engine;
        let raw = base64::engine::general_purpose::STANDARD.decode(&enc).unwrap();
        assert_eq!(raw.len(), 16);
        // Decrypt with the same derivation to check the round trip.
        use aes::cipher::{BlockCipherDecrypt, KeyInit};
        use sha2::Digest;
        let mut key: [u8; 32] = {
            let mut d = sha2::Sha256::new();
            d.update(b"0123456789abcdef0123456789abcdef\n");
            d.update(b"user");
            d.finalize().into()
        };
        for _ in 0..100 {
            key = sha2::Sha256::digest(key).into();
        }
        let cipher = aes::Aes128::new_from_slice(&key[..16]).unwrap();
        let mut block: aes::Block = raw[..16].try_into().unwrap();
        cipher.decrypt_block(&mut block);
        let plain: Vec<u8> = block.iter().zip(&key[16..32]).map(|(a, b)| a ^ b).collect();
        assert_eq!(plain, b"abcdefghijklmnop");
    }

    #[test]
    fn progress_orders_earned_then_locked() {
        let v = serde_json::json!({
            "NumAchievements": 3, "NumAwardedToUser": 2, "NumAwardedToUserHardcore": 0,
            "Achievements": {
                "1": {"Title": "A", "Description": "", "Points": 5, "BadgeName": "111", "DisplayOrder": 1, "DateEarned": "2026-01-01 10:00:00"},
                "2": {"Title": "B", "Description": "", "Points": 10, "BadgeName": "222", "DisplayOrder": 2},
                "3": {"Title": "C", "Description": "", "Points": 25, "BadgeName": "333", "DisplayOrder": 3, "DateEarned": "2026-02-01 10:00:00"}
            }
        });
        let p = parse_progress(42, &v);
        assert_eq!((p.total, p.earned), (3, 2));
        let titles: Vec<_> = p.badges.iter().map(|b| b.title.as_str()).collect();
        assert_eq!(titles, vec!["C", "A", "B"]);
        assert!(p.badges[2].url.ends_with("/Badge/222_lock.png"));
    }
}
