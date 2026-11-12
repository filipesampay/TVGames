//! Cover art for Moonlight's grid: fetched/converted to 600x800 PNG under
//! `~/.cache/tvgames/art/`. Optional SteamGridDB fallback by title.

use crate::config::{cache_dir, ArtCfg};
use crate::model::{ArtSource, Game};
use anyhow::{bail, Context, Result};
use image::imageops::FilterType;
use std::path::{Path, PathBuf};
use std::time::Duration;

const W: u32 = 600;
const H: u32 = 800;

pub struct ArtFetcher {
    http: reqwest::blocking::Client,
    cfg: ArtCfg,
    dir: PathBuf,
}

impl ArtFetcher {
    pub fn new(cfg: &ArtCfg) -> Result<Self> {
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("tvgames/0.1")
            .build()?;
        let dir = cache_dir().join("art");
        std::fs::create_dir_all(&dir)?;
        Ok(Self { http, cfg: cfg.clone(), dir })
    }

    /// Path of a ready-to-use PNG, or `None` if no art could be produced.
    ///
    /// File names carry a hash of the content (`<id>-<hash>.png`): Sunshine
    /// derives app ids from the image *content* but only recomputes them when
    /// the app list changes, so new art must also change the path.
    pub fn ensure(&self, game: &Game) -> Option<PathBuf> {
        let prefix = format!("{}-", sanitize(&game.id));
        if let Some(existing) = self.existing(&prefix) {
            return Some(existing);
        }
        let target = self.dir.join(format!("{}.tmp.png", sanitize(&game.id)));
        let mut sources: Vec<ArtSource> = game.art.iter().cloned().collect();
        if let Some(url) = self.steamgriddb(&game.title) {
            sources.push(ArtSource::Url(url));
        }
        for src in sources {
            match self.load(&src).and_then(|bytes| write_cover(&bytes, &target)) {
                Ok(()) => return self.finalize(&target, &prefix).ok(),
                Err(e) => eprintln!("art: {}: {src:?}: {e:#}", game.title),
            }
        }
        None
    }

    fn existing(&self, prefix: &str) -> Option<PathBuf> {
        std::fs::read_dir(&self.dir).ok()?.flatten().map(|e| e.path()).find(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(prefix) && n.ends_with(".png") && !n.ends_with(".tmp.png"))
        })
    }

    /// Renames the freshly written cover to `<prefix><hash>.png`.
    fn finalize(&self, tmp: &Path, prefix: &str) -> Result<PathBuf> {
        use sha2::Digest;
        let digest = sha2::Sha256::digest(std::fs::read(tmp)?);
        let short: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        let final_path = self.dir.join(format!("{prefix}{short}.png"));
        std::fs::rename(tmp, &final_path)?;
        Ok(final_path)
    }

    fn load(&self, src: &ArtSource) -> Result<Vec<u8>> {
        match src {
            ArtSource::File(p) => std::fs::read(p).with_context(|| format!("reading {}", p.display())),
            ArtSource::Url(u) => self.get(u),
            ArtSource::Libretro { system, name } => match self.get(&libretro_url(system, name)) {
                Ok(bytes) => Ok(bytes),
                Err(_) => {
                    let index = self.libretro_index(system)?;
                    let best = best_match(name, &index).with_context(|| format!("no similar title in {system}"))?;
                    eprintln!("art: {name:?} -> libretro {best:?}");
                    self.get(&libretro_url(system, best.trim_end_matches(".png")))
                }
            },
        }
    }

    fn get(&self, url: &str) -> Result<Vec<u8>> {
        let resp = self.http.get(url).send()?;
        if !resp.status().is_success() {
            bail!("HTTP {}", resp.status());
        }
        Ok(resp.bytes()?.to_vec())
    }

    /// File names in `<system>/Named_Boxarts/`, cached on disk for a week.
    fn libretro_index(&self, system: &str) -> Result<Vec<String>> {
        let cache = cache_dir().join("libretro-index").join(format!("{}.txt", sanitize(system)));
        let fresh = std::fs::metadata(&cache)
            .and_then(|m| m.modified())
            .is_ok_and(|t| t.elapsed().unwrap_or_default() < Duration::from_secs(7 * 24 * 3600));
        if fresh && let Ok(text) = std::fs::read_to_string(&cache) {
            return Ok(text.lines().map(String::from).collect());
        }
        let mut url = reqwest::Url::parse(THUMBS_BASE)?;
        url.path_segments_mut().map_err(|_| anyhow::anyhow!("bad url"))?.push(system).push("Named_Boxarts").push("");
        // Big listings (PS2 has tens of thousands of entries) need more time.
        let resp = self.http.get(url.as_str()).timeout(Duration::from_secs(180)).send()?;
        if !resp.status().is_success() {
            bail!("HTTP {}", resp.status());
        }
        let html = String::from_utf8_lossy(&resp.bytes()?).into_owned();
        let names = parse_index(&html);
        std::fs::create_dir_all(cache.parent().unwrap())?;
        std::fs::write(&cache, names.join("\n"))?;
        Ok(names)
    }

    /// First 600x900 grid for the best title match. Only queried when a key is set.
    fn steamgriddb(&self, title: &str) -> Option<String> {
        let key = self.cfg.steamgriddb_key.as_deref().filter(|k| !k.is_empty())?;
        let get = |url: String| -> Option<serde_json::Value> {
            self.http.get(url).bearer_auth(key).send().ok()?.json().ok()
        };
        let term: String = title.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect();
        let search = get(format!("https://www.steamgriddb.com/api/v2/search/autocomplete/{}", term.trim()))?;
        let id = search["data"][0]["id"].as_u64()?;
        let grids = get(format!("https://www.steamgriddb.com/api/v2/grids/game/{id}?dimensions=600x900"))?;
        grids["data"][0]["url"].as_str().map(String::from)
    }
}

const THUMBS_BASE: &str = "https://thumbnails.libretro.com/";

/// libretro-thumbnails replaces `&*/:`<>?\|"` with `_` in file names.
pub fn libretro_url(system: &str, name: &str) -> String {
    let file: String = name.chars().map(|c| if "&*/:`<>?\\|\"".contains(c) { '_' } else { c }).collect();
    let mut url = reqwest::Url::parse(THUMBS_BASE).expect("static url");
    if let Ok(mut seg) = url.path_segments_mut() {
        seg.push(system).push("Named_Boxarts").push(&format!("{file}.png"));
    }
    url.to_string()
}

/// `.png` file names from an HTML directory listing (`href="..."`, percent-decoded).
fn parse_index(html: &str) -> Vec<String> {
    html.split("href=\"")
        .skip(1)
        .filter_map(|rest| rest.split('"').next())
        .filter(|h| h.ends_with(".png") && !h.contains('/'))
        .map(percent_decode)
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // Work on bytes: slicing the &str could split a multibyte char.
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

const STOPWORDS: &[&str] = &["the", "a", "an", "of", "and"];

/// Lowercase word tokens of a title, without tags, stopwords or punctuation;
/// camelCase is split (`LinkToThePast` → link, past).
fn tokens(s: &str) -> Vec<String> {
    let (title, _) = crate::serve::split_title(s.trim_end_matches(".png"));
    let mut spaced = String::new();
    let mut prev_lower = false;
    for c in title.chars() {
        if c.is_uppercase() && prev_lower {
            spaced.push(' ');
        }
        prev_lower = c.is_lowercase();
        spaced.push(if c.is_alphanumeric() { c } else { ' ' });
    }
    spaced
        .split_whitespace()
        .map(str::to_lowercase)
        .filter(|w| !STOPWORDS.contains(&w.as_str()))
        .collect()
}

/// Best libretro file name for `name`: most of our words present, fewest extra
/// words, then USA/World/Europe releases; betas and demos lose.
pub fn best_match<'a>(name: &str, index: &'a [String]) -> Option<&'a String> {
    let ours = tokens(name);
    if ours.is_empty() {
        return None;
    }
    let region = |n: &str| -> i32 {
        let l = n.to_lowercase();
        if ["beta", "proto", "demo", "sample", "kiosk", "pirate"].iter().any(|b| l.contains(b)) {
            return -10;
        }
        if l.contains("(usa") {
            3
        } else if l.contains("(world") {
            2
        } else if l.contains("(europe") {
            1
        } else {
            0
        }
    };
    index
        .iter()
        .filter_map(|cand| {
            let theirs = tokens(cand);
            let hit = ours.iter().filter(|w| theirs.contains(w)).count();
            let coverage = hit as f64 / ours.len() as f64;
            let extra = theirs.iter().filter(|w| !ours.contains(w)).count() as i32;
            // Last tie-break: shortest name = plain release, not "(Switch Online)" etc.
            (coverage >= 0.8).then_some((cand, (coverage * 100.0) as i32, -extra, region(cand), -(cand.len() as i64)))
        })
        .max_by_key(|(_, cov, extra, reg, len)| (*cov, *extra, *reg, *len))
        .map(|(c, ..)| c)
}

fn write_cover(bytes: &[u8], target: &Path) -> Result<()> {
    let img = image::load_from_memory(bytes).context("decoding image")?;
    let cover = img.resize_to_fill(W, H, FilterType::Lanczos3);
    let tmp = target.with_extension("png.tmp");
    cover.save_with_format(&tmp, image::ImageFormat::Png)?;
    std::fs::rename(&tmp, target)?;
    Ok(())
}

fn sanitize(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_any_image_to_600x800_png() {
        let tmp = tempfile::tempdir().unwrap();
        let src = image::RgbImage::from_pixel(600, 900, image::Rgb([200, 10, 10]));
        let mut jpg = Vec::new();
        image::DynamicImage::ImageRgb8(src)
            .write_to(&mut std::io::Cursor::new(&mut jpg), image::ImageFormat::Jpeg)
            .unwrap();
        let out = tmp.path().join("c.png");
        write_cover(&jpg, &out).unwrap();
        let back = image::open(&out).unwrap();
        assert_eq!((back.width(), back.height()), (600, 800));
    }

    fn idx(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn fuzzy_matches_libretro_titles() {
        let snes = idx(&[
            "Legend of Zelda, The - A Link to the Past (USA, Europe) (Switch Online).png",
            "Legend of Zelda, The - A Link to the Past (Europe).png",
            "Legend of Zelda, The - A Link to the Past (USA).png",
            "Super Mario World (USA).png",
        ]);
        assert_eq!(best_match("Zelda LinkToThePast", &snes).unwrap(), "Legend of Zelda, The - A Link to the Past (USA).png");
        assert_eq!(
            best_match("Legend of Zelda, The - A Link to the Past (BR) (Hyrule Legends) (www.romsportugues.com)", &snes).unwrap(),
            "Legend of Zelda, The - A Link to the Past (USA).png"
        );
        let n64 = idx(&[
            "Legend of Zelda, The - Ocarina of Time (USA).png",
            "Legend of Zelda, The - Ocarina of Time - Master Quest (USA) (GameCube).png",
            "Paper Mario (Europe).png",
            "Paper Mario (USA).png",
            "Paper Mario (USA) (Beta).png",
        ]);
        assert_eq!(
            best_match("The Legend of Zelda - Ocarina of Time Redux (T1.8) (www.romsportugues.com)", &n64).unwrap(),
            "Legend of Zelda, The - Ocarina of Time (USA).png"
        );
        assert_eq!(
            best_match("The Legend of Zelda - Ocarina of Time Redux - Master Quest (T1.8)", &n64).unwrap(),
            "Legend of Zelda, The - Ocarina of Time - Master Quest (USA) (GameCube).png"
        );
        assert_eq!(best_match("Paper Mario (EMULADOR) (BR-USA) (T2.2)", &n64).unwrap(), "Paper Mario (USA).png");
        assert_eq!(best_match("G0d.of.war1.pt.brv.2.1by.david.sander", &n64), None);
    }

    #[test]
    fn parses_directory_listing() {
        let html = r#"<a href="../">../</a><a href="Paper%20Mario%20%28USA%29.png">x</a><a href="sub/">sub/</a>"#;
        assert_eq!(parse_index(html), vec!["Paper Mario (USA).png".to_string()]);
        assert_eq!(
            libretro_url("Nintendo - Nintendo 64", "Tom & Jerry (USA)"),
            "https://thumbnails.libretro.com/Nintendo%20-%20Nintendo%2064/Named_Boxarts/Tom%20_%20Jerry%20(USA).png"
        );
    }

    #[test]
    fn sanitizes_ids_for_filenames() {
        assert_eq!(sanitize("emu:pcsx2:00ff"), "emu_pcsx2_00ff");
    }
}
