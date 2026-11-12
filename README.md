# TVGames

Ponte PC → TV: os jogos do PC (Steam, Heroic, Hydra) e emuladores (PCSX2, DuckStation,
RetroArch para SNES/N64, …) aparecem num app na Android TV. Escolheu o card, o jogo abre
no PC e é transmitido para a TV com o controle Bluetooth da TV.

## Peças

- **Sunshine** (PC) + **Moonlight** (TV): streaming e controle. Não fazem parte deste repo.
- **`tvgames`** (Rust, raiz do repo): descobre os jogos, gera capas, publica os apps no
  Sunshine, prepara a tela durante a sessão e serve a biblioteca para a TV.
- **`tv-app/`** (Android TV, Kotlin + Compose for TV): a interface de cards. Ao escolher um
  jogo, abre o Moonlight direto nele (`ShortcutTrampoline` com o id do app no Sunshine).

## `tvgames`

```sh
cargo install --path .
tvgames init                 # cria ~/.config/tvgames/config.toml (permissão 600)
tvgames scan                 # lista jogos encontrados e os ignorados (com motivo)
tvgames sync                 # capas + publica/atualiza os apps no Sunshine
tvgames serve                # API para o app da TV (porta 47900); ver systemd abaixo
tvgames doctor               # checa Sunshine, tela, TV (ADB) e providers
tvgames cheevos login --user <nome> --api-key <web-api-key>   # RetroAchievements
```

Usados pelo Sunshine (configurados pelo `sync` em cada app):

- `tvgames launch <id>`: abre o jogo e espera ele fechar; ao sair do stream, encerra a
  árvore de processos inteira.
- `tvgames session start|stop`: tela de stream como principal, script KWin que leva
  janelas novas para ela e atalho **Select + Start (segurar 1 s)** para sair.

Fontes de jogos (`src/providers/`): Steam, Heroic (sideload/Epic), Hydra e emuladores por
configuração (`[emulators.<nome>]` no `config.toml`, sem recompilar). PS1/PS2 numa mesma
pasta são separados lendo o `SYSTEM.CNF` do disco. Capas: cache da Steam, Heroic,
libretro-thumbnails (com busca aproximada) e SteamGridDB opcional.

Serviço da API:

```ini
# ~/.config/systemd/user/tvgames-serve.service
[Service]
ExecStart=%h/.cargo/bin/tvgames serve --bind 0.0.0.0:47900
Restart=on-failure
[Install]
WantedBy=default.target
```

## `tv-app`

Precisa de JDK 21 e Android SDK (compileSdk 37). Crie `tv-app/local.properties` com
`sdk.dir=<caminho do SDK>` e:

```sh
cd tv-app
./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

O app acha o PC pelo último endereço que funcionou, por `192.168.50.2` ou pelo anúncio
mDNS do Sunshine (`_nvstream._tcp`).

## Segredos

Nada sensível fica no repo: senha do Sunshine, token e Web API Key do RetroAchievements
ficam em `~/.config/tvgames/config.toml` (fora do repo, permissão 600).
