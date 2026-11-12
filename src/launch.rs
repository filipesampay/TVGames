//! `tvgames launch <id>`: spawn the game and block until it exits, so Sunshine
//! ends the stream (and runs the `undo` prep-cmd) when the game closes.
//! On SIGTERM/SIGINT/SIGHUP (user quit the app in Moonlight) the game is stopped.

use crate::model::{Game, WaitSpec};
use anyhow::{bail, Context, Result};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(1000);
/// A launcher-based game must be gone this long before we call it finished
/// (some games restart their own process once at startup).
const GONE_GRACE: Duration = Duration::from_secs(5);
const KILL_GRACE: Duration = Duration::from_secs(10);

pub fn run(game: &Game) -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT, signal_hook::consts::SIGHUP] {
        signal_hook::flag::register(sig, Arc::clone(&stop))?;
    }
    run_until(game, &stop)
}

/// Like [`run`], with an externally controlled stop flag.
pub fn run_until(game: &Game, stop: &AtomicBool) -> Result<()> {
    let (program, args) = game.launch.split_first().context("empty launch command")?;
    eprintln!("tvgames: launching {} ({}): {:?}", game.title, game.id, game.launch);
    let mut child = Command::new(program)
        .args(args)
        .envs(game.env.iter().cloned())
        .spawn()
        .with_context(|| format!("spawning {program}"))?;

    match &game.wait {
        WaitSpec::Child => wait_child(&mut child, stop),
        WaitSpec::Process { pattern, start_timeout_secs } => {
            let res = wait_process(pattern, Duration::from_secs(*start_timeout_secs), stop);
            // Reap the hand-off process (e.g. `steam steam://...`) if it already exited.
            let _ = child.try_wait();
            res
        }
        WaitSpec::UntilStopped { on_stop } => {
            while !stop.load(Ordering::Relaxed) {
                let _ = child.try_wait();
                std::thread::sleep(POLL);
            }
            eprintln!("tvgames: stop requested, running {on_stop:?}");
            if let Some((p, a)) = on_stop.split_first() {
                let _ = Command::new(p).args(a).envs(game.env.iter().cloned()).status();
            }
            let _ = child.try_wait();
            Ok(())
        }
    }
}

fn wait_child(child: &mut Child, stop: &AtomicBool) -> Result<()> {
    loop {
        if let Some(status) = child.try_wait()? {
            eprintln!("tvgames: game exited: {status}");
            return Ok(());
        }
        if stop.load(Ordering::Relaxed) {
            // The whole tree: `flatpak run` exits on SIGTERM but leaves the
            // sandboxed emulator (bwrap → retroarch/pcsx2) running otherwise.
            let tree = process_tree(&[child.id() as i32]);
            eprintln!("tvgames: stop requested, terminating {tree:?}");
            terminate(&tree);
            let _ = child.wait();
            return Ok(());
        }
        std::thread::sleep(POLL);
    }
}

fn wait_process(pattern: &str, start_timeout: Duration, stop: &AtomicBool) -> Result<()> {
    let start = Instant::now();
    eprintln!("tvgames: waiting for a process matching {pattern:?}");
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        if !matching_pids(pattern).is_empty() {
            break;
        }
        if start.elapsed() > start_timeout {
            bail!("game process matching {pattern:?} did not start within {start_timeout:?}");
        }
        std::thread::sleep(POLL);
    }
    eprintln!("tvgames: game is running");
    let mut gone_since: Option<Instant> = None;
    loop {
        let pids = matching_pids(pattern);
        if stop.load(Ordering::Relaxed) {
            let tree = process_tree(&pids);
            eprintln!("tvgames: stop requested, terminating {tree:?}");
            terminate(&tree);
            return Ok(());
        }
        if pids.is_empty() {
            let since = *gone_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= GONE_GRACE {
                eprintln!("tvgames: game exited");
                return Ok(());
            }
        } else {
            gone_since = None;
        }
        std::thread::sleep(POLL);
    }
}

/// PIDs whose cmdline (args joined by spaces, plus a trailing space) contains
/// `pattern`, case-insensitively. Excludes this process.
pub fn matching_pids(pattern: &str) -> Vec<i32> {
    let me = std::process::id() as i32;
    let pat = pattern.to_lowercase();
    let Ok(entries) = std::fs::read_dir("/proc") else { return vec![] };
    entries
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok())
        .filter(|&pid| pid != me)
        .filter(|pid| {
            std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|raw| cmdline_matches(&raw, &pat))
        })
        .collect()
}

fn cmdline_matches(raw: &[u8], pattern_lower: &str) -> bool {
    if raw.is_empty() {
        return false;
    }
    let mut s: String = raw
        .split(|b| *b == 0)
        .filter(|a| !a.is_empty())
        .map(|a| String::from_utf8_lossy(a).into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    s.push(' ');
    s.to_lowercase().contains(pattern_lower)
}

/// `roots` plus all their descendants, deepest first (so apps get SIGTERM
/// before the wrappers that would otherwise orphan them).
pub fn process_tree(roots: &[i32]) -> Vec<i32> {
    let mut children: std::collections::HashMap<i32, Vec<i32>> = std::collections::HashMap::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for pid in entries.flatten().filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok()) {
            if let Some(ppid) = parent_of(pid) {
                children.entry(ppid).or_default().push(pid);
            }
        }
    }
    let mut order = Vec::new();
    let mut queue: std::collections::VecDeque<i32> = roots.iter().copied().collect();
    while let Some(pid) = queue.pop_front() {
        if order.contains(&pid) {
            continue;
        }
        order.push(pid);
        queue.extend(children.get(&pid).into_iter().flatten().copied());
    }
    order.reverse();
    order
}

fn parent_of(pid: i32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // "<pid> (<comm>) <state> <ppid> ..." — comm may contain spaces/parens.
    stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
}

/// SIGTERM, then SIGKILL whatever is still alive after `KILL_GRACE`.
fn terminate(pids: &[i32]) {
    for &pid in pids {
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    let deadline = Instant::now() + KILL_GRACE;
    while Instant::now() < deadline {
        if pids.iter().all(|&p| !alive(p)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    for &pid in pids {
        if alive(pid) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

fn alive(pid: i32) -> bool {
    // Zombies still have a /proc entry; treat state Z as dead.
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .is_ok_and(|s| s.rsplit_once(')').is_some_and(|(_, rest)| !rest.trim_start().starts_with('Z')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appid_pattern_does_not_match_longer_ids() {
        let raw = b"/steam/reaper\0SteamLaunch\0AppId=5701\0--\0game\0";
        assert!(!cmdline_matches(raw, "appid=570 "));
        assert!(cmdline_matches(raw, "appid=5701 "));
    }

    #[test]
    fn exe_name_matches_case_insensitively() {
        let raw = b"Z:\\Games\\FH6\\ForzaHorizon6.exe\0";
        assert!(cmdline_matches(raw, &"forzahorizon6.exe".to_lowercase()));
    }

    #[test]
    fn child_wait_returns_when_child_exits() {
        let g = Game {
            id: "t".into(),
            title: "t".into(),
            provider: "test".into(),
            category: "test".into(),
            launcher: false,
            rom: None,
            platform: None,
            launch: vec!["/bin/true".into()],
            env: vec![],
            wait: WaitSpec::Child,
            art: None,
        };
        run(&g).unwrap();
    }

    #[test]
    fn until_stopped_runs_on_stop_after_signal() {
        let tmp = tempfile::tempdir().unwrap();
        let flag = tmp.path().join("stopped");
        let g = Game {
            id: "t".into(),
            title: "t".into(),
            provider: "test".into(),
            category: "test".into(),
            launcher: false,
            rom: None,
            platform: None,
            launch: vec!["/bin/true".into()],
            env: vec![],
            wait: WaitSpec::UntilStopped { on_stop: vec!["touch".into(), flag.display().to_string()] },
            art: None,
        };
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = Arc::clone(&stop);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            s2.store(true, Ordering::Relaxed);
        });
        run_until(&g, &stop).unwrap();
        assert!(flag.exists());
    }

    #[test]
    fn stop_kills_grandchildren_too() {
        // wrapper (bash) → inner bash → sleep, like flatpak run → bwrap → emulator.
        let marker = format!("tvgames-tree-{}", std::process::id());
        let g = Game {
            id: "t".into(),
            title: "t".into(),
            provider: "test".into(),
            category: "test".into(),
            launcher: false,
            rom: None,
            platform: None,
            launch: vec!["bash".into(), "-c".into(), format!("bash -c 'exec -a {marker} sleep 30' & wait")],
            env: vec![],
            wait: WaitSpec::Child,
            art: None,
        };
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = Arc::clone(&stop);
        let m2 = marker.clone();
        std::thread::spawn(move || {
            // wait until the grandchild exists, then request stop
            for _ in 0..50 {
                if !matching_pids(&format!("{m2} ")).is_empty() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            s2.store(true, Ordering::Relaxed);
        });
        run_until(&g, &stop).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(matching_pids(&format!("{marker} ")).is_empty(), "grandchild survived");
    }

    #[test]
    fn process_wait_tracks_a_matching_process() {
        let marker = format!("tvgames-test-marker-{}", std::process::id());
        // `sh -c 'exec -a <marker> sleep 2'` gives a process whose argv[0] is the marker.
        let g = Game {
            id: "t".into(),
            title: "t".into(),
            provider: "test".into(),
            category: "test".into(),
            launcher: false,
            rom: None,
            platform: None,
            launch: vec!["bash".into(), "-c".into(), format!("exec -a {marker} sleep 2")],
            env: vec![],
            wait: WaitSpec::Process { pattern: format!("{marker} "), start_timeout_secs: 5 },
            art: None,
        };
        let t = Instant::now();
        run(&g).unwrap();
        // ran ~2s, then GONE_GRACE
        assert!(t.elapsed() >= Duration::from_secs(2));
    }
}
