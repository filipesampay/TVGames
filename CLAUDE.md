# CLAUDE.md

Guia para assistentes de IA trabalhando neste repositório. Para a visão de usuário
(instalação e uso), veja o `README.md`.

## O que é

TVGames transforma o PC (Linux com KDE Plasma Wayland, ou Windows 10/11) num "console" para a Android TV:

1. **`tvgames`** (Rust, raiz do repo) descobre os jogos instalados (Steam, Heroic, Hydra,
   emuladores), baixa capas e publica cada jogo como um *app* no **Sunshine** via API web.
2. Cada app do Sunshine chama `tvgames launch <id>` como `cmd` e `tvgames session start|stop`
   como `prep-cmd` (prepara/restaura a tela e liga o atalho de sair).
3. **`tvgames serve`** expõe uma API HTTP na LAN (porta 47900) com a biblioteca.
4. **`tv-app/`** (Android TV, Kotlin + Compose for TV) lê essa API, mostra os cards e, ao
   escolher um jogo, abre o **Moonlight** direto no app certo (`ShortcutTrampoline`).

Sunshine e Moonlight são dependências externas, não fazem parte do repo.

## Estrutura

```
setup.ps1               instalação guiada para Windows (PowerShell 5.1+): mesma ideia do setup.sh + Firewall do Windows e tarefa agendada "TVGames API"
setup.sh                instalação guiada para máquina nova (bash): checa dependências, IPs, firewall, gera config.toml, instala serviço e app
Cargo.toml              crate binária única `tvgames` (edition 2024)
src/
  main.rs               CLI (clap): init, scan, sync, launch, session, tv, doctor, cheevos, serve, hotkey-watch (oculto)
  model.rs              tipos centrais: Game, WaitSpec, ArtSource, Discovery, Skipped
  config.rs             ~/.config/tvgames/config.toml (serde, tudo com #[serde(default)]); defaults e emuladores padrão
  providers/
    mod.rs              trait Provider + registry() + discover_all() (aplica [library] exclude/rename, ordena)
    steam.rs            libraryfolders.vdf + appmanifest_*.acf; app "Steam Big Picture"
    heroic.rs           sideload + Epic (legendary); lança via heroic://launch
    hydra.rs            lê o LevelDB do Hydra; no Linux exe Windows roda com Proton, no Windows roda direto (não testado ponta a ponta);
                        app "Hydra" (`hydra:bigpicture`, `Hydra.exe --big-picture`, exe achado pelo handler `hydralauncher://` no registro)
    epic.rs             jogos instalados pelo Legendary avulso (`[epic]`, `~/.config/legendary/installed.json`); `legendary launch <app>`
    emulator.rs         emuladores 100% por config ([emulators.<key>]): app "frontend" + um app por ROM
    disc.rs             lê SYSTEM.CNF de ISO/BIN/CUE para separar PS1 de PS2
  sunshine.rs           cliente da API do Sunshine (/api/apps), sync idempotente, cálculo do app id igual ao Sunshine
  launch.rs             lança o jogo e bloqueia até ele terminar; mata a árvore de processos em SIGTERM/SIGINT/SIGHUP;
                        funções de processo têm versão #[cfg(unix)] (/proc + kill) e #[cfg(windows)] (sysinfo + taskkill)
  display.rs            [Linux] kscreen-doctor + script KWin (janelas novas vão para a tela do stream)
  display_windows.rs    [Windows] GDI: snapshot, modo e tela principal via ChangeDisplaySettingsExW; restaura no stop
  hotkey.rs             [Linux] lê /dev/input dos gamepads virtuais do Sunshine; combo segurado fecha o app via API
  hotkey_windows.rs     [Windows] mesmo atalho lendo XInput (pads virtuais do Sunshine via ViGEm)
  art.rs                capas 600x800 PNG em ~/.cache/tvgames/art (Steam/Heroic/arquivo/URL, libretro-thumbnails, SteamGridDB)
                        e fundos largos ("hero", JPEG até 1920x1080) em art/hero/; Steam resolve as URLs reais pela
                        API sem chave IStoreBrowseService/GetItems (library_capsule/library_hero), com fallback no CDN
                        antigo e na librarycache local; emuladores usam Named_Snaps/Named_Titles do libretro como hero.
                        `tvgames sync --refresh-art` baixa tudo de novo (troca as capas → muda app id no Sunshine)
  cheevos.rs            RetroAchievements: hash de ROM (compatível com rcheevos), login, config dos emuladores, progresso
  serve.rs              API LAN (tiny_http): /api/health, /api/library (com `cover`, `hero`, conquistas RA ou Steam e
                        `profile.steam`), /art/<arquivo>.png, /hero/<arquivo>.jpg e as rotas da aba Downloads (store.rs)
  store.rs              aba Downloads: GET /api/stores, /api/store/<steam|epic>/games (comprados e não instalados),
                        /api/install-dirs?store=, POST /api/install {store,id,dir}, GET /api/downloads,
                        POST /api/downloads/<store>/<id>/cancel, GET /api/system. serve.rs também tem
                        POST /api/session/close (fecha o app do Sunshine) e POST /api/power {action: sleep|restart|shutdown}. Steam: lista vem do GetOwnedGames
                        (nunca do librarycache local: o SteamTools/stplug-in põe jogos não comprados lá); instalar = fechar a
                        Steam, criar a biblioteca se a pasta for nova (libraryfolders.vdf), gravar appmanifest com
                        StateFlags 1026 e abrir a Steam (-silent), que baixa sozinha; progresso lido do appmanifest.
                        Epic: Legendary (`auth --import` do Epic Launcher, `install --base-path`), progresso pelo log em
                        <cache>/downloads/epic-<app>.log. Terminou → `tvgames sync`. Jobs em <cache>/downloads.json
  steam_api.rs          Steam Web API com `[steam] api_key` (nunca logar a chave: erros usam `without_url`): perfil
                        (nome, avatar, nível), conquistas e info da loja (descrição, dev, publisher, logo) dos jogos `steam:<appid>`
                        em <cache>/steam.json; atualiza no
                        `sync` e a cada 30 min no `serve`
  tv.rs                 comandos ADB para a TV (wake, abrir Moonlight, Wi-Fi)
tizen-app/              app para TV Samsung: overlay sobre o release oficial do Moonlight Tizen v1.20.0 (GPL-3.0)
  tvgames.js            tela de cards (busca /api/library na porta 47900) e hooks nos globais do Moonlight
  tvgames.css           layout 1920x1080; evita aspect-ratio, inset e gap de flex (Chromium antigo do Tizen)
  build.sh / build.ps1  baixam Moonlight.wgt, injetam js/css/ícone, trocam ids no config.xml, geram dist/TVGames.wgt sem assinatura
tv-app/                 projeto Gradle (Kotlin DSL), módulo :app, pacote dev.tvgames.tv
  app/src/main/java/dev/tvgames/tv/
    MainActivity.kt     estado (Loading/Error/Ready), recarrega no onResume
    Api.kt              Repository: acha o PC (último endereço → 192.168.50.2 → mDNS _nvstream._tcp) e busca /api/library
    Moonlight.kt        Intent para com.limelight/.ShortcutTrampoline com UUID, Name, AppId, AppName
    Covers.kt           cache LRU de imagens (TV tem pouca RAM)
    Ui.kt               UI Compose for TV (header, hero, prateleiras por categoria, conquistas)
```

## Fluxo de dados

- `Game.id` é estável no formato `"<provider>:<chave>"` (ex.: `steam:570`, `emu:pcsx2`,
  `heroic:<appName>`). É o que vai em `tvgames launch <id>`, em `[library] exclude/rename`
  e no cache.
- `tvgames sync` grava `~/.cache/tvgames/library.json`. `launch` e `serve` leem esse cache
  em vez de reescanear. Mudou o formato de `Game`? Lembre que o cache antigo precisa
  continuar desserializando (use `#[serde(default)]`).
- Apps do Sunshine "gerenciados" são reconhecidos pelo `cmd` contendo `tvgames launch `
  (`sunshine::MARKER`). Qualquer outro app (Desktop etc.) nunca é tocado.
- Nomes de app precisam ser únicos (Moonlight endereça por nome): `sync` adiciona ` #2`, ` #3`.
- `serve` recalcula o app id do Sunshine (`sunshine::app_ids`: CRC32 de nome + sha256 da
  imagem, com índice em colisões) porque o Moonlight precisa dele para abrir o jogo direto.
- `WaitSpec` define como `launch` sabe que o jogo ainda está rodando: `Child` (o processo é o
  jogo), `Process { pattern }` (Steam/Heroic só repassam, então espera um processo cujo
  cmdline contém o padrão) e `UntilStopped` (Big Picture).
- `cmd`/`prep-cmd` rodam sem terminal: a saída vai para `~/.cache/tvgames/tvgames.log`.

## Comandos

```sh
cargo build                     # debug
cargo test                      # testes unitários (estão no fim de cada módulo, #[cfg(test)])
cargo clippy --all-targets
cargo fmt
cargo install --path .          # instala em ~/.cargo/bin/tvgames (use esse para `sync`)

tvgames scan [--json]           # o que seria publicado e o que foi ignorado
tvgames sync --dry-run          # JSON dos apps sem tocar no Sunshine
tvgames doctor                  # checa Sunshine, tela, TV e providers

cd tv-app && ./gradlew assembleRelease   # JDK 21 + Android SDK (compileSdk 37); precisa de local.properties com sdk.dir
```

`sync` avisa se for rodado com um binário de `target/`: os apps publicados apontam para o
caminho do executável atual, então publique sempre com o binário instalado.

## API no Windows (tarefa "TVGames API")

`tvgames serve --background` roda pela tarefa agendada com LogonType **Interactive** (sessão do
usuário): a aba Downloads precisa fechar/abrir a Steam do usuário, o que não funciona da sessão 0
(tarefas S4U antigas). `--background` faz FreeConsole e manda a saída para o `tvgames.log`.
`--background` também troca o stdin por NUL: depois do FreeConsole o handle antigo
do console fica morto e todo CreateProcess falha com "os error 50". Programas iniciados
pelo serve (`store::spawn_detached`) tentam `CREATE_BREAKAWAY_FROM_JOB` e, se o job da
tarefa não deixar, iniciam normal; a Steam é aberta via `explorer.exe <steam.exe>` para
não ficar presa ao job da tarefa. Testado: LIMBO (91 MB) instalado pela API em
D:\SteamLibrary, publicado pelo sync automático. Trocar o principal de uma
tarefa existente exige administrador (o `setup.ps1` faz isso quando roda como admin).

## Linux e Windows

O mesmo crate compila para os dois. Regras:

- Módulos inteiros diferentes usam `#[cfg_attr(windows, path = "x_windows.rs")] mod x;` em
  `main.rs` (`display`, `hotkey`) e precisam expor a mesma API pública.
- Diferenças pequenas usam `#[cfg(windows)]`/`#[cfg(unix)]` ou `cfg!(windows)` no próprio
  arquivo (defaults em `config.rs`, Steam em `providers/steam.rs`, caminhos em
  `cheevos.rs::EmulatorPaths`, `sunshine::assets_dir()/config_dir()`).
- Dependências só do Windows (`windows-sys`, `sysinfo`, `winreg`) e só do Unix (`libc`) ficam
  em `[target.'cfg(...)'.dependencies]`.
- Windows específico: o Sunshine encerra o `cmd` com `TerminateProcess` (não dá para tratar),
  então `launch` grava `running.json` com o padrão do jogo e `session stop` fecha o que
  sobrou (`launch::stop_leftovers`). Hand-offs (Steam/Heroic) são criados com
  `CREATE_BREAKAWAY_FROM_JOB`. Jogos da Steam esperam pelo processo cujo caminho contém
  `\steamapps\common\<installdir>\`. Caminhos canonicalizados passam por
  `config::plain_path` (tira o `\\?\`). Apps do Sunshine são reconhecidos por
  `sunshine::managed_id` (aceita `tvgames` e `"...\tvgames.exe"`).
- Não verificado em Windows real: a chave do token do DuckStation (`MachineGuid`) e os
  caminhos padrão dos emuladores. Testado no Wine: testes unitários, `session start/stop`
  (tela e watcher), `launch` + `stop_leftovers`, `scan`, `sync --dry-run` e `serve`.

Checagem antes de entregar mudanças:

```sh
cargo test && cargo clippy --all-targets
cargo clippy --all-targets --target x86_64-pc-windows-gnu
# testes do Windows no Linux (precisa de mingw-w64 e wine):
CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUNNER=wine cargo test --target x86_64-pc-windows-gnu
```

## setup.sh e setup.ps1

Os dois geram o `config.toml` inteiro (não usam `tvgames init`), então **ao adicionar ou
renomear um campo em `config.rs`, atualize `gen_config()` em `setup.sh` e o bloco `$text`
em `setup.ps1`**. O `setup.ps1` grava a config em UTF-8 sem BOM e o próprio arquivo é
salvo em UTF-8 com BOM (o PowerShell 5.1 precisa disso para ler os acentos). Preserva as
seções `[retroachievements]`, `[library]` e `[library.rename]` de uma config existente e
faz backup (`config.toml.bak.*`, permissão 600). Também troca `DEFAULT_HOST` em
`tv-app/.../Api.kt` pelo IP do PC. Pasta de ROMs: `<base>/snes`, `<base>/n64`,
`<base>/playstation` (PS1+PS2 juntos, separados por `disc.rs`), `<base>/capas`.
Valide com `bash -n setup.sh` e `shellcheck -S warning setup.sh`.

## tizen-app (TV Samsung)

- Não recompila o WASM: os scripts de build abrem o `.wgt` do release (fixado em v1.20.0),
  removem as assinaturas, copiam `tvgames.js/css` para `platform/`, injetam as tags antes
  de `</body>` no `index.html` e trocam no `config.xml` id/package/nome (`TVGamesApp`, para
  instalar ao lado do Moonlight).
- **Deploy na TV (automático):** `powershell -ExecutionPolicy Bypass -File tizen-app\install-tv.ps1`
  (`-SkipBuild`, `-NoLaunch`, `-TvIp`). Roda o build, assina com o Tizen CLI (perfil `PlayTV`
  em `C:\tizen-studio-data\profile\profiles.xml`, feito do certificado Partner do Apps2Samsung,
  cópia dos .p12 em `%USERPROFILE%\SamsungCertificate\PlayTV`), instala por `tizen install`
  em `192.168.2.102:26101` (TV `UN50CU7700GXZD`, app id `TVGamesApp.MoonlightWasm`) e abre o app.
  Precisa do Tizen Studio CLI em `C:\tizen-studio` e da TV em modo desenvolvedor com host
  `192.168.2.108` (IP fixo do PC). O .wgt assinado tem que se chamar sem espaço (a TV recusa
  "Play TV.wgt"). O certificado Partner vale até 2027-11-12 e só para esta TV (DUID H3CI7KNS6VDJG).
  O Apps2Samsung (Custom WGT) continua servindo como alternativa manual.
- `tvgames.js` depende destes globais do Moonlight (`wasm/platform/index.js`): `showApps`,
  `showAppsMode`, `showHostsMode`, `showSettingsMode`, `restoreUiAfterWasmLoad`, `hostChosen`,
  `startGame(host, appId)`, `hosts` (por `serverUid`), `localStorage.lastOpenedHost`,
  `Views.Apps` (handlers de navegação, que o TVGames embrulha enquanto está ativo) e
  `host.getAppByName(nome)` (retorna Promise). Ao subir a versão do Moonlight, confira esses nomes.
- Se `/api/library` falhar, cai na grade original do Moonlight. O `serve.rs` manda
  `Access-Control-Allow-Origin: *` porque a página do app vem de outra origem.
- Teste fora da TV: página com stubs desses globais + jQuery + um servidor falso de
  `/api/library`, dirigida com Playwright. Nada foi testado numa TV de verdade ainda.
- JS em ES5 sem emoji literal (use escapes `\uXXXX`).

## Convenções

- **Idiomas:** comentários e doc-comments do código em inglês; mensagens para o usuário
  (saída da CLI, `about` do clap, textos do app da TV) em português.
- **Erros:** `anyhow::Result` com `.context(...)`/`.with_context(...)`; `bail!` para falhas
  esperadas. O `main` imprime `tvgames: error: {e:#}`.
- **Providers nunca derrubam o scan:** erro de um provider vira um `Skipped` com o motivo.
  Itens que não dá para lançar vão em `Discovery::skip(...)` com motivo legível.
- **Adicionar um launcher:** novo módulo em `src/providers/`, implementar `Provider`,
  registrar em `registry()`. **Adicionar emulador:** só config (`[emulators.<key>]` com
  `command`, `rom_args` com `{rom}`, `rom_dirs`, `extensions`, opcional `platform`,
  `thumbnails`, `frontend_args`), sem código. Emuladores padrão ficam em
  `Config::with_default_emulators()`.
- **Integrações externas por subprocesso:** `kscreen-doctor`, `busctl` (KWin Scripting via D-Bus), `adb`, `steam`,
  `flatpak`, `setsid`. Não há bibliotecas para isso; mantenha o padrão de `Command` + checagem
  de status + `context`.
- **HTTP:** `reqwest` blocking com rustls (nada de async/tokio no crate). Servidor: `tiny_http`.
- **Testes:** unitários dentro do próprio módulo, focados em funções puras (parsers, hashes,
  `split_title`, `app_ids`, argumentos). Use `tempfile` para arquivos. Não há testes de
  integração que dependam de Sunshine/TV reais.
- **Segredos:** senha do Sunshine e tokens do RetroAchievements só no `config.toml`
  (gravado com permissão 600 por `Config::save`). Nunca coloque segredos no repo nem em logs.
  A senha do RetroAchievements nunca é salva, só o token.
- O app Android é assinado com a chave debug de propósito (instalado por sideload).

## Premissas do ambiente (valores padrão que são específicos da máquina do autor)

- Linux com KDE Plasma em Wayland (`kscreen-doctor`, KWin scripting). Outros desktops não
  são suportados por `display.rs`. No Windows os defaults são outros (ver `cfg!(windows)` em
  `config.rs`): usuário do Sunshine vazio, `display.output` vazio (não mexe nas telas),
  emuladores em `C:\Program Files\PCSX2`, `C:\RetroArch-Win64` e
  `%USERPROFILE%\Emuladores\DuckStation`.
- Saída de vídeo do stream `HDMI-A-1` em `1920x1080@60`; TV via ADB em `192.168.50.149:5555`;
  PC em `192.168.50.2` (hardcoded como fallback em `tv-app/.../Api.kt`); usuário padrão do
  Sunshine `filipe`; ROMs em `/games/Roms/<console>`; emuladores via Flatpak (PCSX2,
  RetroArch) e AppImage (DuckStation). Ao mexer nesses defaults, prefira torná-los
  configuráveis em vez de trocar um valor fixo por outro.
- O atalho de sair lê `/dev/input/eventN`: o usuário precisa de permissão de leitura (grupo
  `input` na maioria das distros).
- Heroic: GOG e Amazon não implementados. Hydra: não validado ponta a ponta.
