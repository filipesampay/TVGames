//! Session display setup via `kscreen-doctor` (KDE Wayland).
//! `start`: snapshot the layout, put the streamed output in the target mode, make
//! it primary and load a KWin script that sends every new window to it (KWin
//! places new windows on the *active* output, not the primary one).
//! `stop`: unload the script and restore the snapshot.

use crate::config::{cache_dir, DisplayCfg};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct OutputState {
    pub name: String,
    pub enabled: bool,
    pub priority: u32,
    pub mode_id: String,
}

fn state_file() -> PathBuf {
    cache_dir().join("display-state.json")
}

pub fn start(cfg: &DisplayCfg) -> Result<()> {
    let state = state_file();
    // A previous session that died before `stop` left the original layout here:
    // keep it instead of snapshotting the modified one.
    if !state.exists() {
        let outputs = current_outputs()?;
        std::fs::create_dir_all(state.parent().unwrap())?;
        std::fs::write(&state, serde_json::to_string_pretty(&outputs)?)?;
    }
    let o = &cfg.output;
    let mut args = vec![format!("output.{o}.enable"), format!("output.{o}.mode.{}", cfg.mode)];
    if cfg.make_primary {
        args.push(format!("output.{o}.priority.1"));
    }
    kscreen(&args)?;
    if cfg.move_new_windows {
        load_window_script(o)?;
    }
    Ok(())
}

pub fn stop() -> Result<()> {
    // Always unload, even if the layout snapshot is missing.
    if let Err(e) = unload_window_script() {
        eprintln!("tvgames: unloading KWin script: {e:#}");
    }
    let state = state_file();
    if !state.exists() {
        return Ok(());
    }
    let outputs: Vec<OutputState> = serde_json::from_str(&std::fs::read_to_string(&state)?)?;
    kscreen(&restore_args(&outputs))?;
    std::fs::remove_file(&state)?;
    Ok(())
}

pub fn restore_args(outputs: &[OutputState]) -> Vec<String> {
    let mut args = Vec::new();
    for o in outputs {
        if o.enabled {
            args.push(format!("output.{}.enable", o.name));
            args.push(format!("output.{}.mode.{}", o.name, o.mode_id));
            args.push(format!("output.{}.priority.{}", o.name, o.priority));
        } else {
            args.push(format!("output.{}.disable", o.name));
        }
    }
    args
}

pub fn current_outputs() -> Result<Vec<OutputState>> {
    let out = Command::new("kscreen-doctor").arg("-j").output().context("running kscreen-doctor -j")?;
    if !out.status.success() {
        bail!("kscreen-doctor -j failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    parse_outputs(&out.stdout)
}

pub fn parse_outputs(json: &[u8]) -> Result<Vec<OutputState>> {
    let v: serde_json::Value = serde_json::from_slice(json)?;
    let outputs = v["outputs"].as_array().context("no outputs in kscreen-doctor json")?;
    Ok(outputs
        .iter()
        .filter(|o| o["connected"].as_bool().unwrap_or(true))
        .filter_map(|o| {
            Some(OutputState {
                name: o["name"].as_str()?.to_string(),
                enabled: o["enabled"].as_bool().unwrap_or(false),
                priority: o["priority"].as_u64().unwrap_or(0) as u32,
                mode_id: match &o["currentModeId"] {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                },
            })
        })
        .collect())
}

const KWIN_SCRIPT_NAME: &str = "tvgames-follow-stream";

/// KWin 6 script: every normal window opened during the session goes to the
/// streamed output, and is sent back if the app moves it elsewhere afterwards
/// (Steam Big Picture repositions itself onto the leftmost monitor).
pub fn window_script(output: &str) -> String {
    let target = serde_json::to_string(output).expect("string");
    format!(
        r#"const TARGET = {target};
const MAX_MOVES = 20;
function targetOutput() {{
    return workspace.screens.find(s => s.name === TARGET);
}}
function place(w, why) {{
    const out = targetOutput();
    if (!out || w.output === out) return;
    w.tvgamesMoves = (w.tvgamesMoves || 0) + 1;
    if (w.tvgamesMoves > MAX_MOVES) return;
    const wasFull = w.fullScreen;
    workspace.sendClientToScreen(w, out);
    if (wasFull) {{
        // Re-apply fullscreen so it covers the new output.
        w.fullScreen = false;
        w.fullScreen = true;
    }}
    print("tvgames: moved " + w.resourceClass + " (" + why + ") to " + TARGET);
}}
function track(w) {{
    if (!w || !w.normalWindow || w.resourceClass === "plasmashell") return;
    place(w, "opened");
    w.outputChanged.connect(() => place(w, "app moved it"));
}}
workspace.windowAdded.connect(track);
"#
    )
}

fn load_window_script(output: &str) -> Result<()> {
    let path = cache_dir().join("kwin-follow-stream.js");
    std::fs::create_dir_all(cache_dir())?;
    std::fs::write(&path, window_script(output))?;
    unload_window_script()?;
    let path = path.display().to_string();
    kwin_scripting(&["loadScript", "ss", &path, KWIN_SCRIPT_NAME])?;
    kwin_scripting(&["start"])?;
    Ok(())
}

fn unload_window_script() -> Result<()> {
    kwin_scripting(&["unloadScript", "s", KWIN_SCRIPT_NAME]).map(|_| ())
}

fn kwin_scripting(args: &[&str]) -> Result<String> {
    let out = Command::new("busctl")
        .args(["--user", "call", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting"])
        .args(args)
        .output()
        .context("running busctl")?;
    if !out.status.success() {
        bail!("KWin scripting {:?}: {}", args, String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn kscreen(args: &[String]) -> Result<()> {
    eprintln!("tvgames: kscreen-doctor {}", args.join(" "));
    let status = Command::new("kscreen-doctor").args(args).status().context("running kscreen-doctor")?;
    if !status.success() {
        bail!("kscreen-doctor exited with {status}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_restores_layout() {
        let json = br#"{"outputs":[
            {"name":"DP-1","enabled":true,"connected":true,"priority":1,"currentModeId":"2"},
            {"name":"HDMI-A-1","enabled":true,"connected":true,"priority":2,"currentModeId":"33"},
            {"name":"DP-2","enabled":false,"connected":false,"priority":0,"currentModeId":""}
        ]}"#;
        let outs = parse_outputs(json).unwrap();
        assert_eq!(outs.len(), 2);
        assert_eq!(
            restore_args(&outs),
            vec![
                "output.DP-1.enable", "output.DP-1.mode.2", "output.DP-1.priority.1",
                "output.HDMI-A-1.enable", "output.HDMI-A-1.mode.33", "output.HDMI-A-1.priority.2",
            ]
        );
    }
}
