# TVGames

Jogue os jogos do seu PC na Android TV como se fosse um console. Funciona com o PC em
**Windows** (10/11) ou **Linux** (KDE Plasma).

Os jogos instalados no PC (Steam, Heroic, Hydra) e os jogos de emuladores (PlayStation 1 e 2,
Super Nintendo, Nintendo 64, …) aparecem como cards num app na TV. Você escolhe o card com o
controle, o jogo abre no PC e a imagem é transmitida para a TV. O controle Bluetooth ligado
na TV funciona no jogo. Para sair, segure **Select + Start** por 1 segundo.

## Como funciona

```
 PC (Windows ou Linux)                                     Android TV
 ─────────────────────────────────────────                 ──────────────────────
 Steam / Heroic / Hydra / emuladores
        │ descobre jogos, baixa capas
        ▼
 tvgames sync ── cadastra os jogos ──▶ Sunshine ══ stream ══▶ Moonlight
                                                                ▲ abre o jogo
 tvgames serve (porta 47900) ──── lista de jogos ────────▶ app TVGames (cards)
```

O projeto tem três partes:

| Parte | Onde roda | O que faz |
|---|---|---|
| **Sunshine** + **Moonlight** | PC + TV | Streaming de vídeo e controle. Instalados à parte, não fazem parte deste repositório. |
| **`tvgames`** (Rust, raiz do repo) | PC | Descobre os jogos, gera as capas, cadastra cada jogo no Sunshine, prepara a tela durante a sessão e serve a biblioteca para a TV. |
| **`tv-app/`** (Kotlin, Compose for TV) | Android TV | A tela de cards. Ao escolher um jogo, abre o Moonlight direto nele. |
| **`tizen-app/`** (JavaScript, sobre o Moonlight Tizen) | TV Samsung | A mesma tela de cards, com o streaming do Moonlight embutido. Veja [TV Samsung](#tv-samsung-tizen). |

## Requisitos

**No PC com Windows**: veja [Windows](#windows) logo abaixo.

**No PC com Linux**

- Linux com **KDE Plasma em Wayland** (a troca de tela usa `kscreen-doctor` e scripts do KWin).
- [Sunshine](https://github.com/LizardByte/Sunshine) instalado e funcionando, com usuário e
  senha do painel web definidos.
- [Rust](https://rustup.rs) 1.85 ou mais novo (o projeto usa a edição 2024).
- `adb` (Android platform-tools), para os comandos `tvgames tv` e `doctor`. Opcional.
- Os launchers/emuladores que você usa: Steam, Heroic, Hydra, PCSX2 e RetroArch (Flatpak),
  DuckStation (AppImage em `~/Applications/duckstation.AppImage`).
- Permissão de leitura dos controles em `/dev/input` para o atalho de sair. Na maioria das
  distros: `sudo usermod -aG input $USER` e entre de novo na sessão.

**Na TV**

- Android TV com o [Moonlight](https://moonlight-stream.org) instalado e já pareado com o Sunshine.
- Depuração por rede (ADB) ligada, se quiser instalar o app pelo PC.

**Para compilar o app da TV**

- JDK 21 e Android SDK (compileSdk 37).

## Windows

Não use o WSL: o TVGames roda direto no Windows, junto com o Sunshine para Windows.

**Instalação rápida.** Baixe o projeto, abra o PowerShell na pasta dele e rode:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1          # instalação guiada
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Check   # só verifica o que falta
```

Se houver um `tvgames.exe` já compilado na pasta do projeto (como no pacote `TVGames-Windows.zip`),
o `setup.ps1` não pede Rust nem Visual Studio: ele copia o exe para `%LOCALAPPDATA%\tvgames\bin\`.

O `setup.ps1` pede para reabrir como administrador (precisa disso para o firewall e para a
API iniciar sozinha). Ele confere Rust, Visual Studio C++ Build Tools, Sunshine e adb (e
oferece instalar pelo `winget`), descobre o IP do PC e pergunta o da TV, testa o login do
Sunshine, marca a rede como Privada se estiver Pública, cria as regras **TVGames (TCP/UDP)**
no Firewall do Windows, cria a pasta dos jogos, acha os emuladores (ou pergunta onde estão),
gera `%APPDATA%\tvgames\config.toml`, instala o `tvgames`, cria a tarefa agendada
**TVGames API** (a API inicia sozinha no login, sem janela), ajusta o IP do PC no app da
TV e, no fim, roda `tvgames doctor` e `tvgames sync`.

**O que instalar no Windows**

| Programa | Para quê | Onde |
|---|---|---|
| Sunshine | streaming | `winget install LizardByte.Sunshine` |
| Rust + Visual Studio C++ Build Tools | compilar o `tvgames` | `winget install Rustlang.Rustup` e `winget install Microsoft.VisualStudio.2022.BuildTools` (carga "Desenvolvimento para desktop com C++") |
| adb (opcional) | instalar o app na TV pelo PC | `winget install Google.PlatformTools` |
| PCSX2, DuckStation, RetroArch | emuladores | [pcsx2.net](https://pcsx2.net), [duckstation.org](https://www.duckstation.org), [retroarch.com](https://www.retroarch.com) (no RetroArch, baixe os núcleos snes9x e mupen64plus_next) |

**Diferenças em relação ao Linux**

- Pastas: config em `%APPDATA%\tvgames\config.toml`; cache, capas e log em
  `%LOCALAPPDATA%\tvgames\` (o log é `tvgames.log`). Jogos de emulador, por padrão, em
  `%USERPROFILE%\Jogos\Roms\`.
- Tela: com um monitor só, nada muda. Com vários, `display.output` recebe o nome da tela no
  formato `\\.\DISPLAY2` (o setup lista as telas) e o `tvgames` a deixa como principal
  durante o jogo e volta tudo ao final.
- Atalho para sair: **Select + Start** por 1 segundo, lido pelo XInput (o controle da TV
  aparece no PC como um controle de Xbox).
- Jogos da Steam são acompanhados pela pasta de instalação; se o stream for fechado no meio,
  o `tvgames` fecha o jogo quando a sessão termina.
- O app da TV e o Moonlight são os mesmos.

## Instalação rápida no Linux (máquina nova)

Com o repositório clonado no PC (Linux), rode:

```sh
./setup.sh           # instalação guiada
./setup.sh --check   # só verifica o que falta, sem mudar nada
```

O script confere os programas necessários (Rust, Sunshine, KDE, adb, emuladores), descobre o
IP do PC e pergunta o da TV, testa o login do Sunshine, escolhe a tela que vai para a TV,
mostra e libera as portas do firewall, cria a pasta dos jogos com uma subpasta por console,
gera o `config.toml`, instala o `tvgames` e o serviço da API, ajusta o IP do PC no app da TV
(e compila/instala o app se houver Android SDK) e, no fim, roda `tvgames doctor` e
`tvgames sync`. Ele pergunta antes de cada mudança e pode ser rodado de novo quando quiser.

**Portas que a TV precisa acessar no PC:** TCP 47984, 47989, 48010 e 47900; UDP 47998,
47999, 48000, 48002, 48010 e 5353. A porta 47990 (painel do Sunshine) não precisa ser aberta.

**Onde colocar os jogos** (dentro da pasta base escolhida no setup, por padrão `~/Jogos/Roms`):

| Pasta | Jogos |
|---|---|
| `snes/` | Super Nintendo (`.sfc`, `.smc`, `.zip`, …) |
| `n64/` | Nintendo 64 (`.z64`, `.n64`, `.zip`, …) |
| `playstation/` | PS1 e PS2 juntos (`.iso`, `.chd`, `.bin`/`.cue`, …); o console é detectado sozinho |
| `capas/` | Opcional: capa própria com o mesmo nome da ROM (`<nome>.png`) |

Jogos de PC não vão em pasta nenhuma: instale pela Steam, Heroic ou Hydra e eles aparecem
sozinhos. Depois de adicionar jogos, rode `tvgames sync`.

As seções abaixo explicam cada passo manualmente, caso prefira fazer sem o script.

## Instalação passo a passo (Linux)

No Windows o `setup.ps1` faz estes passos; se preferir fazer à mão, os comandos são os
mesmos (`cargo install --path .`, `tvgames init`, editar o `config.toml`, `tvgames sync`).

### 1. Instalar o `tvgames` no PC

```sh
git clone <url-deste-repo> TVGames
cd TVGames
cargo install --path .
```

O binário vai para `~/.cargo/bin/tvgames`. Use sempre esse binário instalado para publicar
os jogos, porque o Sunshine guarda o caminho dele.

### 2. Criar a configuração

```sh
tvgames init --sunshine-password 'sua-senha-do-sunshine'
```

Isso cria `~/.config/tvgames/config.toml` (com permissão 600, só seu usuário lê). Abra o
arquivo e confira principalmente:

```toml
[sunshine]
url = "https://localhost:47990"
username = "seu-usuario-do-sunshine"   # o padrão gerado é "filipe": troque!
password = "..."

[display]
output = "HDMI-A-1"          # a saída que o Sunshine captura (veja `kscreen-doctor -o`)
mode = "1920x1080@60"

[tv]
adb_serial = "192.168.50.149:5555"   # IP da sua TV
```

Os emuladores ficam em `[emulators.<nome>]`. Ajuste `rom_dirs` para a pasta das suas ROMs
(o padrão é `/games/Roms/snes`, `/games/Roms/n64` etc.). Para adicionar outro emulador não
precisa programar nada, só um bloco novo:

```toml
[emulators.meu-emulador]
name = "Nome do Console"
command = ["flatpak", "run", "org.exemplo.Emulador"]
rom_args = ["-fullscreen", "{rom}"]      # {rom} vira o caminho do arquivo
rom_dirs = ["/games/Roms/console"]
extensions = ["iso", "zip"]
frontend_args = ["-bigpicture"]          # opcional: cria um card que abre o menu do emulador
thumbnails = "Nome do sistema no libretro-thumbnails"   # opcional: capas automáticas
```

Outras opções úteis:

- `[library] exclude = ["id-do-jogo"]` esconde um jogo; `[library.rename]` troca o nome exibido.
  Os ids aparecem no `tvgames scan`.
- `[art] steamgriddb_key = "..."` busca capas no SteamGridDB para jogos sem capa.
- `[hotkey] buttons = ["select", "start"]` e `hold_ms = 1000` mudam o atalho de sair.

### 3. Conferir e publicar os jogos

```sh
tvgames doctor    # testa Sunshine, tela, TV e fontes de jogos
tvgames scan      # lista os jogos encontrados e os ignorados (com o motivo)
tvgames sync      # baixa as capas e cadastra/atualiza os jogos no Sunshine
```

Rode `tvgames sync` de novo sempre que instalar ou remover jogos. Ele só mexe nos apps que
ele mesmo criou; os outros apps do Sunshine (como "Desktop") ficam como estão.

### 4. Deixar a API ligada para a TV

O app da TV busca a lista de jogos no PC pela porta **47900**. Crie o serviço do systemd:

```ini
# ~/.config/systemd/user/tvgames-serve.service
[Unit]
Description=TVGames API para o app da TV

[Service]
ExecStart=%h/.cargo/bin/tvgames serve --bind 0.0.0.0:47900
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now tvgames-serve
```

Se tiver firewall, libere a porta 47900 na rede local. Teste no navegador:
`http://<ip-do-pc>:47900/api/library`.

### 5. Compilar e instalar o app na TV

Crie `tv-app/local.properties` com o caminho do Android SDK:

```properties
sdk.dir=/home/seu-usuario/Android/Sdk
```

Depois:

```sh
cd tv-app
./gradlew assembleRelease
adb connect <ip-da-tv>:5555
adb install -r app/build/outputs/apk/release/app-release.apk
```

O app aparece como **TVGames** na tela inicial da TV. Ele encontra o PC sozinho: tenta o
último endereço que funcionou, depois `192.168.50.2` e por fim procura o Sunshine na rede
(mDNS). Se o IP do seu PC for outro e a busca automática falhar, troque `DEFAULT_HOST` em
`tv-app/app/src/main/java/dev/tvgames/tv/Api.kt`.

## TV Samsung (Tizen)

TV Samsung não roda app Android, então o `tv-app/` não serve nela. Para Samsung existe o
`tizen-app/`: é o [Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen) v1.20.0
(port não oficial do Moonlight) com a tela de cards do TVGames por cima. O app abre direto
nos cards, e ao escolher um jogo o stream começa no próprio app. Feito pensando no modelo
UN50CU7700GXZD (2023, Tizen 7).

**1. Gerar o `TVGames.wgt`** (no PC, precisa de internet para baixar o Moonlight Tizen):

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\tizen-app\build.ps1
```

```sh
# Linux (precisa de curl, unzip e zip)
./tizen-app/build.sh
```

O arquivo sai em `tizen-app/dist/TVGames.wgt`. Se já tiver baixado o `Moonlight.wgt`, passe o
caminho dele como argumento para não baixar de novo.

**2. Ligar o modo desenvolvedor na TV:** abra **Apps**, digite **1 2 3 4 5** no controle,
ligue **Developer mode**, coloque o IP do PC que vai instalar e reinicie a TV.

**3. Instalar:** no PC, use o **Apps2Samsung**
(Windows). Escolha a TV, marque **Custom WGT File** e selecione `dist\TVGames.wgt`. Ele pede
login na conta Samsung para assinar o app (obrigatório em TVs com Tizen 7 ou mais novo).

**4. Primeira vez na TV:** abra o **TVGames**. Ele mostra a lista de PCs do Moonlight; escolha o
seu PC e digite no Sunshine (`https://localhost:47990`, aba PIN) o PIN que aparecer. Depois disso
o app abre direto nos cards toda vez.

Botão **Voltar** nos cards leva à lista de PCs e às configurações do Moonlight (resolução, FPS,
bitrate). Se a API do `tvgames serve` não responder, o app mostra a grade normal do Moonlight,
então dá para jogar mesmo assim. O Moonlight Tizen é GPL-3.0; o `TVGames.wgt` gerado também é.

## Usando

1. Abra o app TVGames na TV (Android TV ou Samsung).
2. Escolha um jogo. O Moonlight abre e o jogo inicia no PC.
3. Para sair, segure **Select + Start** por 1 segundo (ou feche o jogo normalmente). A tela
   do PC volta a ser como estava.

Durante a sessão, o `tvgames` deixa a tela do stream como principal e manda as janelas novas
para ela, para o jogo não abrir no monitor errado.

## Conquistas (RetroAchievements)

Opcional. Faz login e já configura RetroArch, DuckStation e PCSX2:

```sh
tvgames cheevos login --user <seu-usuario> --api-key <web-api-key>
tvgames cheevos status    # mostra quais jogos têm conquistas e seu progresso
tvgames cheevos apply     # regrava o login nos emuladores (ex.: depois de resetar um)
```

A senha é pedida no terminal e nunca é salva; só o token fica no `config.toml`. Com a
*Web API Key* (do painel do RetroAchievements), o app da TV mostra seus pontos e o progresso
de cada jogo.

## Outros comandos

| Comando | Para quê |
|---|---|
| `tvgames scan --json` | Lista de jogos em JSON. |
| `tvgames sync --dry-run` | Mostra o que seria publicado sem alterar o Sunshine. |
| `tvgames tv status` | Conexão ADB, Moonlight instalado e qualidade do Wi-Fi da TV. |
| `tvgames tv wake` | Acorda a TV. |
| `tvgames tv moonlight` | Acorda a TV e abre o Moonlight. |
| `tvgames launch <id>`, `tvgames session start/stop` | Usados pelo Sunshine; você não precisa chamar. |

## Problemas comuns

- **O jogo não abre ou a tela não muda:** veja o log em `~/.cache/tvgames/tvgames.log`
  (o Sunshine descarta a saída dos comandos, então ela vai para lá).
- **Um jogo não aparece:** rode `tvgames scan` e veja a seção "ignorados" com o motivo.
- **O app da TV diz que não achou o PC:** confira se `tvgames serve` está rodando
  (`systemctl --user status tvgames-serve`) e se a porta 47900 está liberada.
- **Lista vazia na TV:** rode `tvgames sync` pelo menos uma vez; a API lê o cache que ele gera.
- **O jogo abre na TV mas o controle não faz nada (Windows):** instale o driver
  [ViGEmBus](https://github.com/nefarius/ViGEmBus/releases) e reinicie o PC. É ele que cria o
  controle virtual do Sunshine. O `setup.ps1` avisa quando ele falta.
- **Controle na TV Samsung:** ligue o controle na TV (Bluetooth ou USB) e aperte um botão dele
  antes de escolher o jogo, para o Moonlight reconhecê-lo.
- **Select + Start não fecha o jogo:** seu usuário precisa ler `/dev/input` (grupo `input`).

## Segurança

Nada sensível fica no repositório. Senha do Sunshine e token/Web API Key do RetroAchievements
ficam só em `~/.config/tvgames/config.toml`, com permissão 600.

## Desenvolvimento

```sh
cargo test                   # testes unitários
cargo clippy --all-targets
```

Detalhes de arquitetura e convenções do código estão no [CLAUDE.md](CLAUDE.md).
