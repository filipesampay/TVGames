//! Tells PS1 and PS2 discs apart by reading `SYSTEM.CNF` from the ISO9660
//! filesystem (`BOOT2 =` → PS2, `BOOT =` or `PSX.EXE` → PS1), so one mixed ROM
//! folder can feed both DuckStation and PCSX2.
//!
//! Supports `.iso` (2048-byte sectors), raw `.bin`/`.img` (2352-byte sectors,
//! mode 1 or mode 2) and `.cue` (first data file). Compressed formats (`.chd`,
//! `.cso`, ...) are not inspected: callers fall back to the extension.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Ps1,
    Ps2,
}

impl Platform {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "ps1" | "psx" | "playstation" => Some(Self::Ps1),
            "ps2" | "playstation2" => Some(Self::Ps2),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
struct Layout {
    sector_size: u64,
    data_offset: u64,
}

const COOKED: Layout = Layout { sector_size: 2048, data_offset: 0 };
const SYNC: [u8; 12] = [0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0];

pub fn detect(path: &Path) -> Option<Platform> {
    let mut disc = Disc::open(path)?;
    if let Some(cnf) = disc.system_cnf() {
        let text = String::from_utf8_lossy(&cnf).to_ascii_uppercase();
        if text.contains("BOOT2") {
            return Some(Platform::Ps2);
        }
        if text.contains("BOOT") {
            return Some(Platform::Ps1);
        }
    }
    disc.find_file("PSX.EXE").map(|_| Platform::Ps1)
}

/// First `FILE "..."` of a cue sheet, resolved next to the cue.
fn cue_data_file(cue: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(cue).ok()?;
    let line = text.lines().map(str::trim).find(|l| l.to_ascii_uppercase().starts_with("FILE "))?;
    let name = if let Some(rest) = line[5..].trim_start().strip_prefix('"') {
        rest.split('"').next()?.to_string()
    } else {
        line[5..].split_whitespace().next()?.to_string()
    };
    Some(cue.parent()?.join(name))
}

struct DirEntry {
    /// Raw identifier, e.g. `SLUS_007.07;1` or a directory name.
    name: String,
    lba: u32,
    size: u32,
    is_dir: bool,
}

/// Read-only ISO9660 access to the data track of a disc image.
pub struct Disc {
    file: File,
    layout: Layout,
}

impl Disc {
    /// `.iso` (2048-byte sectors), raw `.bin`/`.img` (2352) or `.cue` (first file).
    pub fn open(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
        let (data, layout) = match ext.as_str() {
            "iso" => (path.to_path_buf(), Some(COOKED)),
            "bin" | "img" => (path.to_path_buf(), None),
            "cue" => (cue_data_file(path)?, None),
            _ => return None,
        };
        let mut file = File::open(data).ok()?;
        let layout = match layout {
            Some(l) => l,
            None => raw_layout(&mut file)?,
        };
        let mut disc = Self { file, layout };
        let pvd = disc.sector(16)?;
        (pvd[0] == 1 && &pvd[1..6] == b"CD001").then_some(disc)
    }

    /// The 2048 user-data bytes of sector `lba`.
    pub fn sector(&mut self, lba: u32) -> Option<[u8; 2048]> {
        let mut buf = [0u8; 2048];
        let pos = u64::from(lba) * self.layout.sector_size + self.layout.data_offset;
        self.file.seek(SeekFrom::Start(pos)).ok()?;
        self.file.read_exact(&mut buf).ok()?;
        Some(buf)
    }

    fn root(&mut self) -> Option<(u32, u32)> {
        let pvd = self.sector(16)?;
        let rec = &pvd[156..190];
        Some((le32(&rec[2..6]), le32(&rec[10..14])))
    }

    fn list_dir(&mut self, lba: u32, len: u32) -> Option<Vec<DirEntry>> {
        let mut out = Vec::new();
        for i in 0..len.div_ceil(2048).min(256) {
            let sector = self.sector(lba + i)?;
            let mut off = 0usize;
            while off + 33 < 2048 {
                let rec_len = sector[off] as usize;
                if rec_len == 0 {
                    break; // records never cross sectors: rest is padding
                }
                let rec = &sector[off..(off + rec_len).min(2048)];
                let name_len = rec[32] as usize;
                if let Some(raw) = rec.get(33..33 + name_len) {
                    // 0x00 / 0x01 are the "." and ".." entries.
                    if !(name_len == 1 && raw[0] <= 1) {
                        out.push(DirEntry {
                            name: String::from_utf8_lossy(raw).into_owned(),
                            lba: le32(&rec[2..6]),
                            size: le32(&rec[10..14]),
                            is_dir: rec[25] & 0x02 != 0,
                        });
                    }
                }
                off += rec_len;
            }
        }
        Some(out)
    }

    /// `(lba, size)` of a file given a `\\`-separated path, matched like
    /// rcheevos: case-insensitive, ignoring the `;1` version suffix.
    pub fn find_file(&mut self, path: &str) -> Option<(u32, u32)> {
        let path = path.trim_start_matches('\\');
        let (mut lba, mut len) = self.root()?;
        let mut parts = path.split('\\').peekable();
        while let Some(part) = parts.next() {
            let entries = self.list_dir(lba, len)?;
            if parts.peek().is_some() {
                let dir = entries.iter().find(|e| e.is_dir && e.name.eq_ignore_ascii_case(part))?;
                (lba, len) = (dir.lba, dir.size);
            } else {
                let file = entries.iter().find(|e| {
                    let n = e.name.as_str();
                    n.len() >= part.len()
                        && n[..part.len()].eq_ignore_ascii_case(part)
                        && (n.len() == part.len() || n.as_bytes()[part.len()] == b';')
                })?;
                return Some((file.lba, file.size));
            }
        }
        None
    }

    /// Up to `size` bytes stored contiguously from sector `lba`.
    pub fn read_file(&mut self, lba: u32, size: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(size as usize);
        let mut sector = lba;
        while out.len() < size as usize {
            let Some(data) = self.sector(sector) else { break };
            let take = (size as usize - out.len()).min(2048);
            out.extend_from_slice(&data[..take]);
            sector += 1;
        }
        out
    }

    /// The first sector of `SYSTEM.CNF` (what rcheevos reads).
    pub fn system_cnf(&mut self) -> Option<Vec<u8>> {
        let (lba, _) = self.find_file("SYSTEM.CNF")?;
        Some(self.sector(lba)?.to_vec())
    }
}

/// Raw 2352-byte sectors start with the CD sync pattern; the mode byte tells
/// where the 2048 bytes of user data begin.
fn raw_layout(f: &mut File) -> Option<Layout> {
    let mut head = [0u8; 16];
    f.read_exact(&mut head).ok()?;
    if head[..12] != SYNC {
        return Some(COOKED);
    }
    let data_offset = if head[15] == 2 { 24 } else { 16 };
    Some(Layout { sector_size: 2352, data_offset })
}

fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal ISO9660: PVD at 16, root dir at 18, SYSTEM.CNF at 19.
    fn iso_sectors(cnf: &str) -> Vec<[u8; 2048]> {
        let mut s = vec![[0u8; 2048]; 20];
        s[16][0] = 1;
        s[16][1..6].copy_from_slice(b"CD001");
        let root = &mut s[16][156..190];
        root[0] = 34;
        root[2..6].copy_from_slice(&18u32.to_le_bytes());
        root[10..14].copy_from_slice(&2048u32.to_le_bytes());
        let name = b"SYSTEM.CNF;1";
        let len = 33 + name.len() + 1;
        let rec = &mut s[18][..len];
        rec[0] = len as u8;
        rec[2..6].copy_from_slice(&19u32.to_le_bytes());
        rec[10..14].copy_from_slice(&(cnf.len() as u32).to_le_bytes());
        rec[32] = name.len() as u8;
        rec[33..33 + name.len()].copy_from_slice(name);
        s[19][..cnf.len()].copy_from_slice(cnf.as_bytes());
        s
    }

    fn write_iso(path: &Path, cnf: &str) {
        let data: Vec<u8> = iso_sectors(cnf).concat();
        std::fs::write(path, data).unwrap();
    }

    fn write_raw_mode2(path: &Path, cnf: &str) {
        let mut data = Vec::new();
        for sector in iso_sectors(cnf) {
            let mut raw = [0u8; 2352];
            raw[..12].copy_from_slice(&SYNC);
            raw[15] = 2;
            raw[24..24 + 2048].copy_from_slice(&sector);
            data.extend_from_slice(&raw);
        }
        std::fs::write(path, data).unwrap();
    }

    #[test]
    fn detects_ps2_iso_and_ps1_bin_cue() {
        let tmp = tempfile::tempdir().unwrap();
        let iso = tmp.path().join("gow.iso");
        write_iso(&iso, "BOOT2 = cdrom0:\\SCUS_973.99;1\r\nVER = 1.00\r\n");
        assert_eq!(detect(&iso), Some(Platform::Ps2));

        let bin = tmp.path().join("Crash (USA).bin");
        write_raw_mode2(&bin, "BOOT = cdrom:\\SCUS_949.00;1\r\nTCB = 4\r\n");
        assert_eq!(detect(&bin), Some(Platform::Ps1));
        let cue = tmp.path().join("Crash (USA).cue");
        std::fs::write(&cue, "FILE \"Crash (USA).bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n").unwrap();
        assert_eq!(detect(&cue), Some(Platform::Ps1));
    }

    #[test]
    fn unknown_formats_and_garbage_are_none() {
        let tmp = tempfile::tempdir().unwrap();
        let junk = tmp.path().join("x.iso");
        std::fs::write(&junk, vec![7u8; 50_000]).unwrap();
        assert_eq!(detect(&junk), None);
        let chd = tmp.path().join("x.chd");
        std::fs::write(&chd, b"MComprHD").unwrap();
        assert_eq!(detect(&chd), None);
    }
}
