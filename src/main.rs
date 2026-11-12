//! tvgames — PC-side orchestrator that publishes local games and emulators to
//! Sunshine, so they show up in Moonlight on the TV.

mod art;
mod cheevos;
mod config;
mod display;
mod hotkey;
mod launch;
mod model;
mod providers;
mod serve;
mod sunshine;
mod tv;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use config::{cache_dir, config_path, Config};
use model::Game;
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about = "Publica jogos/emuladores do PC no Sunshine para jogar na TV via Moonlight")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Cria ~/.config/tvgames/config.toml (não sobrescreve um existente).
    Init {
        /// Senha do web UI do Sunshine (ou variável TVGAMES_SUNSHINE_PASSWORD).
        #[arg(long, env = "TVGAMES_SUNSHINE_PASSWORD", hide_env_values = true)]
        sunshine_password: Option<String>,
    },
    /// Lista os jogos encontrados e os que foram ignorados (com o motivo).
    Scan {
        #[arg(long)]
        json: bool,
    },
    /// Descobre os jogos, gera capas e publica no Sunshine.
    Sync {
        /// Mostra o que seria publicado sem alterar o Sunshine.
        #[arg(long)]
        dry_run: bool,
    },
    /// Lança um jogo e bloqueia até ele fechar (usado pelo Sunshine).
    Launch { id: String },
    /// Preparação/restauração da tela (prep-cmd do Sunshine).
    Session {
        #[command(subcommand)]
        action: SessionAction,
    },
    /// Comandos para a TV via ADB.
    Tv {
        #[command(subcommand)]
        action: TvAction,
    },
    /// Verifica Sunshine, TV, tela e providers.
    Doctor,
    /// RetroAchievements: login, configuração dos emuladores e progresso.
    Cheevos {
        #[command(subcommand)]
        action: CheevosAction,
    },
    /// API na rede local para o app da TV.
    Serve {
        #[arg(long, default_value = "0.0.0.0:47900")]
        bind: String,
    },
    /// (interno) Vigia o atalho de sair no controle durante a sessão.
    #[command(name = "hotkey-watch", hide = true)]
    HotkeyWatch,
}

#[derive(Subcommand)]
enum CheevosAction {
    /// Faz login (troca a senha por um token) e configura RetroArch, DuckStation e PCSX2.
    Login {
        #[arg(long)]
        user: String,
        /// Senha (ou variável TVGAMES_RA_PASSWORD; sem nenhuma, é lida da entrada padrão).
        #[arg(long, env = "TVGAMES_RA_PASSWORD", hide_env_values = true)]
        password: Option<String>,
        /// "Web API Key" do painel do RetroAchievements (progresso na TV).
        #[arg(long)]
        api_key: Option<String>,
    },
    /// Regrava o login na config dos emuladores (ex.: depois de resetar um deles).
    Apply,
    /// Hash, id e progresso de cada jogo.
    Status,
}

#[derive(Subcommand)]
enum SessionAction {
    Start,
    Stop,
}

#[derive(Subcommand)]
enum TvAction {
    /// Conexão ADB, Moonlight instalado e qualidade do Wi-Fi.
    Status,
    /// Acorda a TV.
    Wake,
    /// Acorda a TV e abre o Moonlight.
    Moonlight,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if matches!(cli.cmd, Cmd::Launch { .. } | Cmd::Session { .. } | Cmd::HotkeyWatch) {
        log_to_file_when_headless();
    }
    let res = run(cli);
    if let Err(e) = &res {
        eprintln!("tvgames: error: {e:#}");
    }
    res
}

/// Sunshine discards the output of `cmd`/`prep-cmd`. When stderr is not a
/// terminal, append it (and the game's inherited output) to
/// `~/.cache/tvgames/tvgames.log`.
fn log_to_file_when_headless() {
    use std::io::IsTerminal;
    use std::os::fd::AsRawFd;
    if std::io::stderr().is_terminal() {
        return;
    }
    let path = cache_dir().join("tvgames.log");
    let _ = std::fs::create_dir_all(cache_dir());
    let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else { return };
    unsafe {
        libc::dup2(file.as_raw_fd(), 1);
        libc::dup2(file.as_raw_fd(), 2);
    }
    let now = std::process::Command::new("date").arg("+%F %T").output().ok();
    let now = now.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    eprintln!("\n=== {now} tvgames {}", std::env::args().skip(1).collect::<Vec<_>>().join(" "));
}

fn run(cli: Cli) -> Result<()> {
    match cli.cmd {
        Cmd::Init { sunshine_password } => init(sunshine_password),
        Cmd::Scan { json } => scan(&Config::load()?, json),
        Cmd::Sync { dry_run } => sync(&Config::load()?, dry_run),
        Cmd::Launch { id } => {
            let cfg = Config::load()?;
            let game = find_game(&cfg, &id)?;
            launch::run(&game)
        }
        Cmd::Session { action: SessionAction::Start } => {
            let cfg = Config::load()?;
            if cfg.hotkey.enabled {
                // A missing hotkey must not block the game from starting.
                if let Err(e) = hotkey::spawn_watcher() {
                    eprintln!("tvgames: hotkey: {e:#}");
                }
            }
            display::start(&cfg.display)
        }
        Cmd::Session { action: SessionAction::Stop } => {
            hotkey::stop_watcher();
            // Achievements may have been unlocked: let the API refresh progress.
            cheevos::mark_dirty();
            display::stop()
        }
        Cmd::Cheevos { action } => cheevos_cmd(action),
        Cmd::HotkeyWatch => hotkey::watch(&Config::load()?),
        Cmd::Serve { bind } => serve::serve(&Config::load()?, &bind),
        Cmd::Tv { action } => tv_cmd(&Config::load()?, action),
        Cmd::Doctor => doctor(&Config::load()?),
    }
}

fn init(password: Option<String>) -> Result<()> {
    let path = config_path();
    if path.exists() {
        bail!("{} já existe; edite-o diretamente", path.display());
    }
    let mut cfg = Config::with_default_emulators();
    cfg.sunshine.password = password.unwrap_or_default();
    cfg.save(&path)?;
    println!("config criada em {} (permissão 600)", path.display());
    if cfg.sunshine.password.is_empty() {
        println!("aviso: preencha sunshine.password antes de rodar `tvgames sync`");
    }
    Ok(())
}

fn library_cache() -> PathBuf {
    cache_dir().join("library.json")
}

fn scan(cfg: &Config, json: bool) -> Result<()> {
    let d = providers::discover_all(cfg);
    if json {
        println!("{}", serde_json::to_string_pretty(&d.games)?);
        return Ok(());
    }
    println!("{} jogo(s):", d.games.len());
    for g in &d.games {
        println!("  {:<40} {}", g.title, g.id);
    }
    if !d.skipped.is_empty() {
        println!("\nignorados ({}):", d.skipped.len());
        for s in &d.skipped {
            println!("  [{}] {} — {}", s.provider, s.title, s.reason);
        }
    }
    Ok(())
}

fn sync(cfg: &Config, dry_run: bool) -> Result<()> {
    let mut d = providers::discover_all(cfg);
    // Moonlight/the TV app address apps by name: names must be unique.
    let mut seen = std::collections::HashMap::<String, usize>::new();
    for g in &mut d.games {
        let n = seen.entry(g.title.to_lowercase()).or_insert(0);
        *n += 1;
        if *n > 1 {
            g.title = format!("{} #{}", g.title, n);
        }
    }
    let exe = std::env::current_exe()?.canonicalize()?;
    if exe.components().any(|c| c.as_os_str() == "target") {
        eprintln!("aviso: publicando com um binário de build ({}); prefira `cargo install --path .`", exe.display());
    }
    let fetcher = art::ArtFetcher::new(&cfg.art)?;
    let apps: Vec<_> = d
        .games
        .iter()
        .map(|g| {
            let img = if dry_run { None } else { fetcher.ensure(g) };
            sunshine::app_for(g, &exe, img.as_deref())
        })
        .collect();
    if dry_run {
        println!("{}", serde_json::to_string_pretty(&apps)?);
        return Ok(());
    }
    // `launch` resolves ids from this cache instead of rescanning every time.
    std::fs::create_dir_all(cache_dir())?;
    std::fs::write(library_cache(), serde_json::to_string_pretty(&d.games)?)?;

    let client = sunshine::Sunshine::new(&cfg.sunshine)?;
    let report = client.sync(&apps)?;
    if report.unchanged {
        println!("Sunshine já está atualizado ({} jogo(s))", apps.len());
    } else {
        println!("Sunshine: {} removido(s), {} publicado(s)", report.removed, report.added);
    }
    if !d.skipped.is_empty() {
        println!("{} item(ns) ignorado(s); veja `tvgames scan`", d.skipped.len());
    }
    Ok(())
}

fn find_game(cfg: &Config, id: &str) -> Result<Game> {
    if let Ok(text) = std::fs::read_to_string(library_cache()) {
        let games: Vec<Game> = serde_json::from_str(&text).context("reading library cache")?;
        if let Some(g) = games.into_iter().find(|g| g.id == id) {
            return Ok(g);
        }
    }
    providers::discover_all(cfg)
        .games
        .into_iter()
        .find(|g| g.id == id)
        .with_context(|| format!("jogo {id} não encontrado; rode `tvgames scan`"))
}

fn cheevos_cmd(action: CheevosAction) -> Result<()> {
    let path = config_path();
    let mut cfg = Config::load()?;
    match action {
        CheevosAction::Login { user, password, api_key } => {
            let password = match password {
                Some(p) => p,
                None => {
                    eprint!("Senha do RetroAchievements para {user}: ");
                    let mut line = String::new();
                    std::io::stdin().read_line(&mut line)?;
                    line.trim_end_matches(['\r', '\n']).to_string()
                }
            };
            let (user, token) = cheevos::Client::new()?.login(&user, &password)?;
            println!("login ok: {user}");
            cfg.retroachievements.username = user;
            cfg.retroachievements.token = token;
            if let Some(k) = api_key {
                cfg.retroachievements.web_api_key = k;
            }
            cfg.save(&path)?;
            for line in cheevos::apply_to_emulators(&cfg.retroachievements)? {
                println!("  {line}");
            }
        }
        CheevosAction::Apply => {
            for line in cheevos::apply_to_emulators(&cfg.retroachievements)? {
                println!("{line}");
            }
        }
        CheevosAction::Status => {
            let games: Vec<Game> = providers::discover_all(&cfg).games;
            let cache = cheevos::refresh(&cfg, &games, true);
            if let Some(p) = cache.profile() {
                println!("{}: {} pontos (softcore {})\n", p.user, p.points, p.softcore_points);
            }
            for g in games.iter().filter(|g| g.rom.is_some()) {
                match cache.game_id_for(g) {
                    Some((_, 0)) | None => println!("  {:<55} sem conquistas (hash não reconhecido)", g.title),
                    Some((_, id)) => match cache.progress_for(g) {
                        Some(p) => println!("  {:<55} #{id}: {}/{} conquistas", g.title, p.earned, p.total),
                        None => println!("  {:<55} #{id}", g.title),
                    },
                }
            }
        }
    }
    Ok(())
}

fn tv_cmd(cfg: &Config, action: TvAction) -> Result<()> {
    let tv = tv::Tv::new(&cfg.tv.adb_serial);
    tv.connect()?;
    match action {
        TvAction::Status => {
            println!("ADB: conectado em {}", cfg.tv.adb_serial);
            println!("Moonlight instalado: {}", tv.moonlight_installed()?);
            println!("Wi-Fi: {}", tv.wifi_summary()?);
        }
        TvAction::Wake => tv.wake()?,
        TvAction::Moonlight => {
            tv.wake()?;
            tv.open_moonlight()?;
        }
    }
    Ok(())
}

fn doctor(cfg: &Config) -> Result<()> {
    let ok = |b: bool| if b { "ok " } else { "FALHA" };
    println!("config: {}", config_path().display());

    let sun = sunshine::Sunshine::new(&cfg.sunshine).and_then(|s| s.apps());
    match &sun {
        Ok(apps) => println!(
            "[{}] Sunshine API ({} apps, {} gerenciados pelo tvgames)",
            ok(true),
            apps.len(),
            apps.iter().filter(|a| sunshine::is_managed(a)).count()
        ),
        Err(e) => println!("[{}] Sunshine API: {e:#}", ok(false)),
    }

    match display::current_outputs() {
        Ok(outs) => {
            let found = outs.iter().any(|o| o.name == cfg.display.output);
            println!("[{}] tela de stream {} ({:?})", ok(found), cfg.display.output, outs.iter().map(|o| &o.name).collect::<Vec<_>>());
        }
        Err(e) => println!("[{}] kscreen-doctor: {e:#}", ok(false)),
    }

    let tv = tv::Tv::new(&cfg.tv.adb_serial);
    match tv.connect().and_then(|_| tv.moonlight_installed()) {
        Ok(m) => {
            println!("[{}] TV via ADB, Moonlight instalado: {m}", ok(m));
            if let Ok(w) = tv.wifi_summary() {
                println!("      Wi-Fi da TV: {w}");
            }
        }
        Err(e) => println!("[{}] TV via ADB: {e:#}", ok(false)),
    }

    let d = providers::discover_all(cfg);
    println!("[{}] {} jogo(s) publicáveis, {} ignorado(s)", ok(!d.games.is_empty()), d.games.len(), d.skipped.len());
    Ok(())
}
