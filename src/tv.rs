//! TV helpers over ADB (Android TV). Shells out to the `adb` binary.

use anyhow::{bail, Context, Result};
use std::process::Command;

pub const MOONLIGHT_PKG: &str = "com.limelight";

pub struct Tv {
    serial: String,
}

impl Tv {
    pub fn new(serial: &str) -> Self {
        Self { serial: serial.to_string() }
    }

    fn adb(&self, args: &[&str]) -> Result<String> {
        let out = Command::new("adb").arg("-s").arg(&self.serial).args(args).output().context("running adb")?;
        if !out.status.success() {
            bail!("adb {:?}: {}", args, String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub fn connect(&self) -> Result<()> {
        let out = Command::new("adb").args(["connect", &self.serial]).output().context("running adb")?;
        let text = String::from_utf8_lossy(&out.stdout);
        if text.contains("connected") {
            Ok(())
        } else {
            bail!("adb connect {}: {}", self.serial, text.trim())
        }
    }

    pub fn shell(&self, cmd: &str) -> Result<String> {
        self.adb(&["shell", cmd])
    }

    pub fn wake(&self) -> Result<()> {
        self.shell("input keyevent KEYCODE_WAKEUP").map(|_| ())
    }

    pub fn open_moonlight(&self) -> Result<()> {
        self.shell(&format!("monkey -p {MOONLIGHT_PKG} -c android.intent.category.LEANBACK_LAUNCHER 1"))
            .map(|_| ())
    }

    pub fn moonlight_installed(&self) -> Result<bool> {
        Ok(self.shell(&format!("pm list packages {MOONLIGHT_PKG}"))?.contains(MOONLIGHT_PKG))
    }

    /// e.g. `SSID "FILIPE_5G", RSSI -83, link 81 Mbps, 5520 MHz`
    pub fn wifi_summary(&self) -> Result<String> {
        let dump = self.shell("dumpsys wifi")?;
        let line = dump.lines().find(|l| l.contains("mWifiInfo")).unwrap_or("").to_string();
        Ok(summarize_wifi(&line))
    }
}

pub fn summarize_wifi(line: &str) -> String {
    let field = |key: &str| -> Option<String> {
        let start = line.find(key)? + key.len();
        let rest = &line[start..];
        Some(rest.split(',').next()?.trim().to_string())
    };
    match (field("SSID: "), field("RSSI: "), field("Link speed: "), field("Frequency: ")) {
        (Some(ssid), Some(rssi), Some(link), Some(freq)) => {
            format!("SSID {ssid}, RSSI {rssi} dBm, link {link}, {freq}")
        }
        _ => "Wi-Fi info unavailable (cabled or not connected?)".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_real_dumpsys_line() {
        let line = r#"mWifiInfo SSID: "FILIPE_5G", BSSID: 90:9f:22:c8:ae:e2, MAC: e6:f8:b4:d6:8b:7c, IP: /192.168.50.149, Security type: 2, Supplicant state: COMPLETED, Wi-Fi standard: 4, RSSI: -83, Link speed: 81Mbps, Tx Link speed: 81Mbps, Frequency: 5520MHz, Net ID: 2"#;
        assert_eq!(summarize_wifi(line), r#"SSID "FILIPE_5G", RSSI -83 dBm, link 81Mbps, 5520MHz"#);
    }
}
