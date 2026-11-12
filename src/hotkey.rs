//! Quit hotkey. Moonlight's own quit combo is hardcoded (Start+Select+LB+RB)
//! and only disconnects, so the PC watches Sunshine's virtual gamepads during a
//! session: when every combo button is held for `hold_ms`, the running app is
//! closed through the Sunshine API (ends the game, the stream and the session).
//!
//! `session start` spawns `tvgames hotkey-watch` in the background; `session stop`
//! kills it.

use crate::config::{cache_dir, Config};
use crate::sunshine::Sunshine;
use anyhow::{bail, Context, Result};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const EV_KEY: u16 = 0x01;
/// `struct input_event` on 64-bit Linux: timeval (16) + type (2) + code (2) + value (4).
const EVENT_SIZE: usize = 24;
const WATCH_ARG: &str = "hotkey-watch";

pub fn button_code(name: &str) -> Option<u16> {
    Some(match name.to_ascii_lowercase().as_str() {
        "a" | "south" => 0x130,
        "b" | "east" => 0x131,
        "x" | "west" => 0x133,
        "y" | "north" => 0x134,
        "lb" | "l1" => 0x136,
        "rb" | "r1" => 0x137,
        "select" | "back" | "view" => 0x13a,
        "start" | "menu" => 0x13b,
        "guide" | "mode" | "xbox" => 0x13c,
        "l3" => 0x13d,
        "r3" => 0x13e,
        _ => return None,
    })
}

fn combo_codes(cfg: &Config) -> Result<HashSet<u16>> {
    cfg.hotkey
        .buttons
        .iter()
        .map(|b| button_code(b).with_context(|| format!("hotkey: unknown button {b:?}")))
        .collect()
}

fn pid_file() -> PathBuf {
    cache_dir().join("hotkey-watch.pid")
}

/// Starts the background watcher (replacing a stale one).
pub fn spawn_watcher() -> Result<()> {
    stop_watcher();
    let exe = std::env::current_exe()?;
    let child = {
        use std::os::unix::process::CommandExt;
        Command::new(exe)
            .arg(WATCH_ARG)
            .stdin(Stdio::null())
            // Own process group: not part of Sunshine's prep-cmd/app groups.
            .process_group(0)
            .spawn()
            .context("spawning hotkey watcher")?
    };
    std::fs::create_dir_all(cache_dir())?;
    std::fs::write(pid_file(), child.id().to_string())?;
    eprintln!("tvgames: hotkey watcher started (pid {})", child.id());
    Ok(())
}

pub fn stop_watcher() {
    let Ok(text) = std::fs::read_to_string(pid_file()) else { return };
    let _ = std::fs::remove_file(pid_file());
    let Ok(pid) = text.trim().parse::<i32>() else { return };
    // Only kill it if that pid is still our watcher.
    let is_watcher = std::fs::read(format!("/proc/{pid}/cmdline"))
        .is_ok_and(|c| c.split(|b| *b == 0).any(|a| a == WATCH_ARG.as_bytes()));
    if is_watcher {
        unsafe { libc::kill(pid, libc::SIGTERM) };
        eprintln!("tvgames: hotkey watcher stopped (pid {pid})");
    }
}

#[derive(Default)]
struct PadState {
    pressed: HashSet<u16>,
    combo_since: Option<Instant>,
}

/// Updates `state` with one key event and (re)starts/clears the combo timer.
fn apply_key(state: &mut PadState, combo: &HashSet<u16>, code: u16, value: i32, now: Instant) {
    if !combo.contains(&code) {
        return;
    }
    if value == 0 {
        state.pressed.remove(&code);
    } else {
        state.pressed.insert(code);
    }
    let complete = combo.iter().all(|c| state.pressed.contains(c));
    state.combo_since = match (complete, state.combo_since) {
        (true, Some(t)) => Some(t),
        (true, None) => Some(now),
        (false, _) => None,
    };
}

/// (type, code, value) of a raw `input_event`.
fn parse_event(buf: &[u8; EVENT_SIZE]) -> (u16, u16, i32) {
    let ty = u16::from_ne_bytes([buf[16], buf[17]]);
    let code = u16::from_ne_bytes([buf[18], buf[19]]);
    let value = i32::from_ne_bytes([buf[20], buf[21], buf[22], buf[23]]);
    (ty, code, value)
}

/// `/dev/input/eventN` of every device whose name contains `name_match`.
fn find_pads(devices: &str, name_match: &str) -> Vec<PathBuf> {
    devices
        .split("\n\n")
        .filter(|block| {
            block.lines().any(|l| l.starts_with("N: Name=") && l.contains(name_match))
                && block.lines().any(|l| l.starts_with("H: Handlers=") && l.contains("js"))
        })
        .filter_map(|block| {
            let handlers = block.lines().find_map(|l| l.strip_prefix("H: Handlers="))?;
            let ev = handlers.split_whitespace().find(|h| h.starts_with("event"))?;
            Some(PathBuf::from(format!("/dev/input/{ev}")))
        })
        .collect()
}

pub fn watch(cfg: &Config) -> Result<()> {
    if !cfg.hotkey.enabled {
        return Ok(());
    }
    let combo = Arc::new(combo_codes(cfg)?);
    if combo.is_empty() {
        bail!("hotkey.buttons is empty");
    }
    let hold = Duration::from_millis(cfg.hotkey.hold_ms);
    let stop = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&stop))?;
    signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&stop))?;

    let pads: Arc<Mutex<HashMap<PathBuf, PadState>>> = Arc::default();
    let mut last_scan: Option<Instant> = None;
    eprintln!("tvgames: hotkey watcher waiting for {:?} held {hold:?}", cfg.hotkey.buttons);

    while !stop.load(Ordering::Relaxed) {
        if last_scan.is_none_or(|t| t.elapsed() >= Duration::from_secs(1)) {
            last_scan = Some(Instant::now());
            let devices = std::fs::read_to_string("/proc/bus/input/devices").unwrap_or_default();
            for path in find_pads(&devices, &cfg.hotkey.device_match) {
                let mut map = pads.lock().unwrap();
                if map.contains_key(&path) {
                    continue;
                }
                map.insert(path.clone(), PadState::default());
                drop(map);
                eprintln!("tvgames: hotkey watching {}", path.display());
                spawn_reader(path, Arc::clone(&pads), Arc::clone(&combo));
            }
        }
        let triggered = pads
            .lock()
            .unwrap()
            .values()
            .any(|p| p.combo_since.is_some_and(|t| t.elapsed() >= hold));
        if triggered {
            eprintln!("tvgames: quit hotkey pressed, closing the running app");
            Sunshine::new(&cfg.sunshine)?.close_app()?;
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

fn spawn_reader(path: PathBuf, pads: Arc<Mutex<HashMap<PathBuf, PadState>>>, combo: Arc<HashSet<u16>>) {
    std::thread::spawn(move || {
        let res = (|| -> Result<()> {
            let mut f = std::fs::File::open(&path)?;
            let mut buf = [0u8; EVENT_SIZE];
            loop {
                f.read_exact(&mut buf)?;
                let (ty, code, value) = parse_event(&buf);
                if ty == EV_KEY
                    && let Some(state) = pads.lock().unwrap().get_mut(&path)
                {
                    apply_key(state, &combo, code, value, Instant::now());
                }
            }
        })();
        // Device went away (stream ended / reconnect): forget it so a new one is picked up.
        pads.lock().unwrap().remove(&path);
        if let Err(e) = res {
            eprintln!("tvgames: hotkey stopped reading {}: {e}", path.display());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn combo() -> HashSet<u16> {
        [0x13a, 0x13b].into_iter().collect()
    }

    #[test]
    fn combo_completes_only_with_all_buttons_and_resets_on_release() {
        let c = combo();
        let mut s = PadState::default();
        let t0 = Instant::now();
        apply_key(&mut s, &c, 0x13a, 1, t0);
        assert!(s.combo_since.is_none());
        apply_key(&mut s, &c, 0x130, 1, t0); // A: not part of the combo
        apply_key(&mut s, &c, 0x13b, 1, t0);
        assert_eq!(s.combo_since, Some(t0));
        // key repeat (value 2) keeps the original start time
        apply_key(&mut s, &c, 0x13b, 2, t0 + Duration::from_millis(500));
        assert_eq!(s.combo_since, Some(t0));
        apply_key(&mut s, &c, 0x13a, 0, t0);
        assert!(s.combo_since.is_none());
    }

    #[test]
    fn parses_raw_input_event() {
        let mut buf = [0u8; EVENT_SIZE];
        buf[16..18].copy_from_slice(&EV_KEY.to_ne_bytes());
        buf[18..20].copy_from_slice(&0x13bu16.to_ne_bytes());
        buf[20..24].copy_from_slice(&1i32.to_ne_bytes());
        assert_eq!(parse_event(&buf), (EV_KEY, 0x13b, 1));
    }

    #[test]
    fn finds_only_sunshine_gamepads() {
        let devices = "I: Bus=0003\nN: Name=\"GameSir T4 pro\"\nH: Handlers=kbd event9 js0\n\n\
                       I: Bus=0003\nN: Name=\"Sunshine (libvirtualhid) X-Box Series Controller\"\nH: Handlers=kbd event24 js1\n\n\
                       I: Bus=0003\nN: Name=\"libvirtualhid Mouse\"\nH: Handlers=mouse2 event20\n\n\
                       I: Bus=0003\nN: Name=\"Sunshine pad 2\"\nH: Handlers=event9 js2 \n";
        assert_eq!(
            find_pads(devices, "Sunshine"),
            vec![PathBuf::from("/dev/input/event24"), PathBuf::from("/dev/input/event9")]
        );
    }

    #[test]
    fn button_names() {
        assert_eq!(button_code("Select"), Some(0x13a));
        assert_eq!(button_code("start"), Some(0x13b));
        assert_eq!(button_code("nope"), None);
    }
}
