#!/usr/bin/env bash
# TVGames: instalação guiada numa máquina nova.
#
# Verifica o que falta, descobre/pergunta os IPs, mostra e libera as portas do
# firewall, define onde ficam os jogos, gera ~/.config/tvgames/config.toml,
# instala o `tvgames` e o serviço da API, prepara o app da TV e, no fim, roda
# `tvgames doctor` e `tvgames sync` para deixar tudo pronto para jogar.
#
# Uso:
#   ./setup.sh           instalação interativa (pergunta antes de cada mudança)
#   ./setup.sh --check   só verifica e mostra o relatório, sem alterar nada
#
# Pode ser rodado de novo quando quiser: ele mostra os valores atuais como padrão.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tvgames"
CONFIG="$CONFIG_DIR/config.toml"
API_PORT=47900
ME=$(id -un)
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1
[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { sed -n 2,13p "$0" | sed 's/^# \{0,1\}//'; exit 0; }

# Portas do Sunshine (porta base 47989) + API do tvgames + mDNS.
TCP_PORTS=(47984 47989 48010 "$API_PORT")
UDP_PORTS=(47998 47999 48000 48002 48010 5353)

# ------------------------------------------------------------------ helpers --

if [[ -t 1 ]]; then
  B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else
  B=""; G=""; Y=""; R=""; C=""; N=""
fi
FAILS=0; WARNS=0
step()  { printf '\n%s== %s ==%s\n' "$B$C" "$*" "$N"; }
ok()    { printf '  %s[ok]%s    %s\n' "$G" "$N" "$*"; }
warn()  { printf '  %s[aviso]%s %s\n' "$Y" "$N" "$*"; WARNS=$((WARNS + 1)); }
fail()  { printf '  %s[falta]%s %s\n' "$R" "$N" "$*"; FAILS=$((FAILS + 1)); }
info()  { printf '          %s\n' "$*"; }
have()  { command -v "$1" >/dev/null 2>&1; }

# ask VAR "Pergunta" "padrão"
ask() {
  local __var=$1 __q=$2 __def=${3:-} __ans
  if (( CHECK_ONLY )); then printf -v "$__var" '%s' "$__def"; return; fi
  if [[ -n "$__def" ]]; then read -r -p "  $__q [$__def]: " __ans; else read -r -p "  $__q: " __ans; fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}
ask_secret() {
  local __var=$1 __q=$2 __def=${3:-} __ans
  if (( CHECK_ONLY )); then printf -v "$__var" '%s' "$__def"; return; fi
  if [[ -n "$__def" ]]; then read -r -s -p "  $__q [Enter mantém a atual]: " __ans
  else read -r -s -p "  $__q: " __ans; fi
  echo
  printf -v "$__var" '%s' "${__ans:-$__def}"
}
# confirm "Pergunta" → 0 se sim. Em --check sempre "não".
confirm() {
  (( CHECK_ONLY )) && return 1
  local a; read -r -p "  $1 [S/n]: " a
  [[ -z "$a" || "$a" =~ ^[sSyY] ]]
}
# Valor atual de uma chave no config existente: cur <seção> <chave>
cur() {
  [[ -f "$CONFIG" ]] || return 0
  awk -v sec="[$1]" -v key="$2" '
    /^\[/ { insec = ($0 == sec); next }
    insec && $0 ~ "^"key"[ ]*=" {
      sub(/^[^=]*=[ ]*/, ""); gsub(/^"|"$/, ""); print; exit
    }' "$CONFIG"
}
# String TOML entre aspas (escapa \ e ").
tq() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }

pkg_hint() {
  if have pacman; then echo "sudo pacman -S $*"
  elif have apt; then echo "sudo apt install $*"
  elif have dnf; then echo "sudo dnf install $*"
  elif have zypper; then echo "sudo zypper install $*"
  else echo "instale: $*"; fi
}

printf '%sTVGames: instalação guiada%s\n' "$B" "$N"
(( CHECK_ONLY )) && echo "Modo --check: nada será alterado."
[[ -f "$CONFIG" ]] && echo "Config existente encontrada em $CONFIG: os valores atuais aparecem como padrão."

# ----------------------------------------------------------------- sistema --

step "1. Sistema"
if [[ "$(uname -s)" != Linux ]]; then
  fail "o TVGames roda no PC com Linux (detectado: $(uname -s))."
  exit 1
fi
ok "Linux ($(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-?}"))"
if [[ "${XDG_CURRENT_DESKTOP:-}" == *KDE* ]]; then ok "KDE Plasma"; else
  warn "desktop '${XDG_CURRENT_DESKTOP:-?}': a troca de tela durante o jogo só funciona no KDE Plasma"; fi
if [[ "${XDG_SESSION_TYPE:-}" == wayland ]]; then ok "sessão Wayland"; else
  warn "sessão '${XDG_SESSION_TYPE:-?}': o TVGames foi feito para KDE em Wayland"; fi

# ------------------------------------------------------------ dependências --

step "2. Programas necessários"
check_cmd() { # check_cmd <comando> <obrigatório 1/0> <para quê> <pacote>
  if have "$1"; then ok "$1 ($3)"
  elif [[ "$2" == 1 ]]; then fail "$1: $3. $(pkg_hint "$4")"
  else warn "$1 não encontrado: $3. $(pkg_hint "$4")"; fi
}
check_cmd cargo 1 "compilar o tvgames" "rustup  (depois: rustup default stable)"
check_cmd curl 1 "testar o Sunshine" curl
check_cmd kscreen-doctor 1 "trocar a tela durante o jogo" "kscreen"
check_cmd busctl 1 "script do KWin" systemd
check_cmd setsid 1 "abrir jogos da Steam" util-linux
check_cmd adb 0 "falar com a TV e instalar o app" "android-tools (ou adb)"
check_cmd flatpak 0 "PCSX2 e RetroArch" flatpak
check_cmd steam 0 "jogos da Steam" steam
check_cmd ip 1 "descobrir o IP do PC" iproute2
if have cargo; then
  rv=$(rustc --version 2>/dev/null | awk '{print $2}')
  if [[ "$(printf '%s\n1.85.0\n' "$rv" | sort -V | head -1)" != 1.85.0 ]]; then
    fail "Rust $rv é antigo: precisa de 1.85+ (rustup update)"
  fi
fi

if have sunshine || [[ -x /usr/bin/sunshine ]] || flatpak info dev.lizardbyte.app.Sunshine >/dev/null 2>&1; then
  ok "Sunshine instalado"
else
  fail "Sunshine não encontrado: https://github.com/LizardByte/Sunshine/releases"
fi
if systemctl --user is-active --quiet sunshine 2>/dev/null || pgrep -x sunshine >/dev/null; then
  ok "Sunshine rodando"
else
  warn "Sunshine não está rodando agora (systemctl --user enable --now sunshine)"
fi

if id -nG | tr ' ' '\n' | grep -qx input; then
  ok "usuário no grupo 'input' (atalho Select+Start para sair)"
else
  warn "usuário fora do grupo 'input': o atalho Select+Start para sair não vai funcionar"
  if confirm "Adicionar $ME ao grupo input agora (precisa de sudo; vale depois de sair e entrar na sessão)?"; then
    sudo usermod -aG input "$ME" && ok "adicionado; saia e entre de novo na sessão"
  fi
fi

# ------------------------------------------------------------------- rede --

step "3. Rede e IPs"
PC_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
PC_IF=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}')
LAN_CIDR=$(ip -4 -o addr show dev "${PC_IF:-lo}" 2>/dev/null | awk '{print $4}' | head -1)
if [[ -n "$PC_IP" ]]; then
  ok "IP deste PC: $PC_IP (interface $PC_IF, rede $LAN_CIDR)"
  info "Dica: fixe esse IP no roteador (reserva DHCP) para a TV sempre achar o PC."
else
  fail "não consegui descobrir o IP deste PC (está conectado à rede?)"
fi

cur_tv=$(cur tv adb_serial); cur_tv=${cur_tv%:5555}
if have adb && [[ -z "$cur_tv" ]]; then
  cur_tv=$(adb devices 2>/dev/null | awk 'NR>1 && $1 ~ /:5555$/ {sub(/:5555$/,"",$1); print $1; exit}')
fi
echo "  Na TV: Configurações > Rede > (sua rede) mostra o IP. Ative também a depuração ADB"
echo "  (Configurações > Preferências do dispositivo > Sobre: clique 7x em Build; depois Opções do desenvolvedor)."
ask TV_IP "IP da TV" "$cur_tv"
if [[ -n "$TV_IP" ]]; then
  if ping -c1 -W2 "$TV_IP" >/dev/null 2>&1; then ok "TV responde em $TV_IP"; else warn "TV não respondeu ao ping em $TV_IP (ligada? mesma rede?)"; fi
  if have adb && ! (( CHECK_ONLY )); then
    if adb connect "$TV_IP:5555" 2>&1 | grep -q connected; then
      ok "ADB conectado (aceite o aviso na TV na primeira vez)"
      if adb -s "$TV_IP:5555" shell pm list packages com.limelight 2>/dev/null | grep -q limelight; then
        ok "Moonlight instalado na TV"
      else
        warn "Moonlight não está na TV: instale pela Play Store da TV e pareie com este PC"
      fi
    else
      warn "ADB não conectou em $TV_IP:5555 (depuração ADB ligada na TV?)"
    fi
  fi
else
  warn "IP da TV em branco: os comandos 'tvgames tv' e a instalação do app pelo PC não vão funcionar"
fi

# --------------------------------------------------------------- Sunshine --

step "4. Sunshine"
SUN_URL=$(cur sunshine url); SUN_URL=${SUN_URL:-https://localhost:47990}
ask SUN_USER "Usuário do painel web do Sunshine" "$(cur sunshine username)"
ask_secret SUN_PASS "Senha do painel web do Sunshine" "$(cur sunshine password)"
if [[ -n "$SUN_USER" && -n "$SUN_PASS" ]] && have curl; then
  code=$(curl -sk -o /dev/null -w '%{http_code}' -u "$SUN_USER:$SUN_PASS" "$SUN_URL/api/apps" || true)
  case "$code" in
    200) ok "login no Sunshine funcionou ($SUN_URL)";;
    401) fail "Sunshine recusou usuário/senha (confira em $SUN_URL)";;
    000) fail "Sunshine não respondeu em $SUN_URL (está rodando?)";;
    *)   warn "Sunshine respondeu HTTP $code";;
  esac
else
  fail "usuário/senha do Sunshine em branco (crie em $SUN_URL na primeira vez que abrir)"
fi

# -------------------------------------------------------------------- tela --

step "5. Tela que vai para a TV"
OUTPUTS=""
if have kscreen-doctor; then
  OUTPUTS=$(kscreen-doctor -o 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | awk '/^Output:/ {print $3}')
fi
SUN_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/sunshine/sunshine.conf"
sun_out=$(awk -F= '$1 ~ /^[ ]*output_name[ ]*$/ {gsub(/ /,"",$2); print $2}' "$SUN_CONF" 2>/dev/null)
[[ -n "$OUTPUTS" ]] && info "Saídas de vídeo deste PC: $(echo $OUTPUTS)"
[[ -n "$sun_out" ]] && info "O Sunshine captura: $sun_out (output_name em $SUN_CONF)"
def_out=$(cur display output); def_out=${def_out:-${sun_out:-$(echo "$OUTPUTS" | grep -m1 HDMI || true)}}
ask DISP_OUT "Saída que o Sunshine transmite" "${def_out:-HDMI-A-1}"
def_mode=$(cur display mode)
ask DISP_MODE "Resolução durante o jogo (LxA@Hz)" "${def_mode:-1920x1080@60}"
if [[ -n "$OUTPUTS" ]] && ! grep -qx "$DISP_OUT" <<<"$OUTPUTS"; then
  warn "a saída $DISP_OUT não existe agora (cabo/dummy plug HDMI conectado?)"
fi
if [[ -n "$sun_out" && "$sun_out" != "$DISP_OUT" ]]; then
  warn "o Sunshine está capturando $sun_out, não $DISP_OUT: ajuste output_name no painel do Sunshine"
fi

# ------------------------------------------------------------------- jogos --

step "6. Onde ficam os jogos"
STEAM_ROOT=$(cur steam root); STEAM_ROOT=${STEAM_ROOT:-$HOME/.local/share/Steam}
[[ -d "$STEAM_ROOT" ]] || { [[ -d "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam" ]] && STEAM_ROOT="$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam"; }
if [[ -d "$STEAM_ROOT/steamapps" ]]; then STEAM_ON=true; ok "Steam: $STEAM_ROOT (os jogos instalados pela Steam entram sozinhos)"
else STEAM_ON=false; warn "Steam não encontrada em $STEAM_ROOT (desativada)"; fi

HEROIC_DIR="$HOME/.config/heroic"; HEROIC_BIN=$(cur heroic binary)
for b in "$HEROIC_BIN" /opt/Heroic/heroic "$(command -v heroic 2>/dev/null)"; do [[ -n "$b" && -x "$b" ]] && { HEROIC_BIN=$b; break; }; done
if [[ -d "$HEROIC_DIR" && -x "${HEROIC_BIN:-/nonexistent}" ]]; then HEROIC_ON=true; ok "Heroic: $HEROIC_BIN (jogos Epic e adicionados manualmente entram sozinhos)"
else HEROIC_ON=false; HEROIC_BIN=${HEROIC_BIN:-/opt/Heroic/heroic}
  warn "Heroic (versão instalada, não Flatpak) não encontrado: desativado"; fi

HYDRA_DIR="$HOME/.config/hydralauncher/hydra-db"
if [[ -d "$HYDRA_DIR" ]]; then HYDRA_ON=true; ok "Hydra: $HYDRA_DIR (cada jogo precisa ter o executável escolhido no Hydra)"
else HYDRA_ON=false; info "Hydra não encontrado (desativado)"; fi

echo
echo "  Os jogos de emulador (ROMs) ficam todos numa pasta base, com uma subpasta por console:"
cur_snes=$(awk '/^\[emulators\.snes\]/{f=1;next} /^\[/{f=0} f && /^rom_dirs/' "$CONFIG" 2>/dev/null | grep -o '"[^"]*"' | head -1 | tr -d '"')
ask ROMS "Pasta base das ROMs" "$(dirname "${cur_snes:-$HOME/Jogos/Roms/snes}")"
ROMS=${ROMS%/}; ROMS=${ROMS/#\~/$HOME}
ROM_SNES="$ROMS/snes"; ROM_N64="$ROMS/n64"; ROM_PS="$ROMS/playstation"; COVERS="$ROMS/capas"
if ! (( CHECK_ONLY )); then
  if mkdir -p "$ROM_SNES" "$ROM_N64" "$ROM_PS" "$COVERS" 2>/dev/null; then ok "pastas criadas em $ROMS"
  else fail "não consegui criar $ROMS (sem permissão? use uma pasta dentro de $HOME ou crie com sudo e dê chown)"; fi
fi

# Emuladores: só ativa o que estiver instalado.
flat() { have flatpak && flatpak info "$1" >/dev/null 2>&1; }
DUCK=$(cur emulators.duckstation command | tr -d '[]"' ); DUCK=${DUCK:-}
[[ -x "$DUCK" ]] || DUCK=$(ls "$HOME"/Applications/*[Dd]uck[Ss]tation*.AppImage 2>/dev/null | head -1)
if flat net.pcsx2.PCSX2; then PCSX2_ON=true; ok "PCSX2 (PS2)"; else PCSX2_ON=false; warn "PCSX2 não instalado: flatpak install flathub net.pcsx2.PCSX2"; fi
if [[ -n "$DUCK" && -x "$DUCK" ]]; then DUCK_ON=true; ok "DuckStation (PS1): $DUCK"
else DUCK_ON=false; DUCK="$HOME/Applications/duckstation.AppImage"
  warn "DuckStation não encontrado: baixe o AppImage em https://www.duckstation.org e salve como $DUCK (chmod +x)"; fi
if flat org.libretro.RetroArch; then RA_ON=true; ok "RetroArch (SNES e N64)"
  CORES="$HOME/.var/app/org.libretro.RetroArch/config/retroarch/cores"
  for core in snes9x mupen64plus_next; do
    [[ -f "$CORES/${core}_libretro.so" ]] || warn "núcleo $core não baixado: no RetroArch, Menu principal > Baixar núcleos > $core"
  done
else RA_ON=false; CORES="$HOME/.var/app/org.libretro.RetroArch/config/retroarch/cores"
  warn "RetroArch não instalado: flatpak install flathub org.libretro.RetroArch"; fi
if [[ "$PCSX2_ON" == true ]] && ! ls "$HOME/.var/app/net.pcsx2.PCSX2/config/PCSX2/bios/"* >/dev/null 2>&1; then
  warn "PCSX2 sem BIOS: abra o PCSX2 uma vez e configure a BIOS do PS2"
fi

# ---------------------------------------------------------------- firewall --

step "7. Firewall (portas que a TV precisa acessar neste PC)"
info "TCP: ${TCP_PORTS[*]}   (47984/47989/48010 Sunshine, $API_PORT API do TVGames)"
info "UDP: ${UDP_PORTS[*]}   (vídeo/áudio/controle do Sunshine, 5353 descoberta mDNS)"
info "A porta 47990 (painel web do Sunshine) NÃO precisa ser aberta para a rede."
if have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
  missing=()
  for p in "${TCP_PORTS[@]}"; do firewall-cmd --query-port="$p/tcp" >/dev/null 2>&1 || missing+=("$p/tcp"); done
  for p in "${UDP_PORTS[@]}"; do firewall-cmd --query-port="$p/udp" >/dev/null 2>&1 || missing+=("$p/udp"); done
  if (( ${#missing[@]} == 0 )); then ok "firewalld: todas as portas liberadas"
  else
    warn "firewalld: faltam ${missing[*]}"
    if confirm "Liberar essas portas no firewalld (sudo)?"; then
      for p in "${missing[@]}"; do sudo firewall-cmd --permanent --add-port="$p" >/dev/null; done
      sudo firewall-cmd --reload >/dev/null && ok "portas liberadas"
    fi
  fi
elif have ufw && sudo -n ufw status >/dev/null 2>&1 && sudo -n ufw status | grep -q "Status: active"; then
  warn "ufw ativo: as portas serão liberadas só para a rede local ${LAN_CIDR:-}"
  if confirm "Liberar as portas no ufw (sudo)?"; then
    from=${LAN_CIDR:+from $LAN_CIDR}; from=${from:-from any}
    for p in "${TCP_PORTS[@]}"; do sudo ufw allow $from to any port "$p" proto tcp >/dev/null; done
    for p in "${UDP_PORTS[@]}"; do sudo ufw allow $from to any port "$p" proto udp >/dev/null; done
    ok "portas liberadas no ufw"
  fi
elif have ufw; then
  info "ufw instalado: se estiver ativo, rode 'sudo ufw status'. Para liberar:"
  info "  for p in ${TCP_PORTS[*]}; do sudo ufw allow \$p/tcp; done; for p in ${UDP_PORTS[*]}; do sudo ufw allow \$p/udp; done"
else
  ok "nenhum firewall ativo detectado (firewalld/ufw)"
fi

# ------------------------------------------------------------------ config --

step "8. Configuração ($CONFIG)"
SGDB=$(cur art steamgriddb_key)
STEAM_KEY=$(cur steam api_key)
LEGENDARY=$(cur epic legendary); LEGENDARY=${LEGENDARY:-$HOME/.local/bin/legendary}
emu_block() { # emu_block key enabled name command_toml frontend_toml rom_args_toml rom_dirs_toml exts_toml platform thumbs
  printf '\n[emulators.%s]\nenabled = %s\nname = %s\ncommand = %s\nfrontend_args = %s\nrom_args = %s\nrom_dirs = %s\nextensions = %s\n' \
    "$1" "$2" "$(tq "$3")" "$4" "$5" "$6" "$7" "$8"
  [[ -n "$9" ]] && printf 'platform = %s\n' "$(tq "$9")"
  [[ -n "${10}" ]] && printf 'thumbnails = %s\n' "$(tq "${10}")"
  [[ "$7" != "[]" ]] && printf 'covers_dir = %s\n' "$(tq "$COVERS")"
  return 0
}
RA_CMD='["flatpak", "run", "org.libretro.RetroArch"]'
gen_config() {
  cat <<EOF
# Gerado por setup.sh em $(date '+%F %T'). Pode editar à vontade; rode ./setup.sh de novo quando quiser.

[sunshine]
url = $(tq "$SUN_URL")
username = $(tq "$SUN_USER")
password = $(tq "$SUN_PASS")

[display]
output = $(tq "$DISP_OUT")
mode = $(tq "$DISP_MODE")
make_primary = true
move_new_windows = true

[tv]
adb_serial = $(tq "${TV_IP:+$TV_IP:5555}")

[steam]
enabled = $STEAM_ON
root = $(tq "$STEAM_ROOT")
big_picture = $STEAM_ON
# Chave da Steam Web API (steamcommunity.com/dev/apikey): aba Downloads e troféus da Steam na TV.
api_key = $(tq "$STEAM_KEY")

[heroic]
enabled = $HEROIC_ON
config_dir = $(tq "$HEROIC_DIR")
binary = $(tq "$HEROIC_BIN")

[epic]
# Legendary (github.com/legendary-gl/legendary): aba Downloads da Epic na TV.
enabled = true
legendary = $(tq "$LEGENDARY")

[hydra]
enabled = $HYDRA_ON
db_dir = $(tq "$HYDRA_DIR")

[hotkey]
enabled = true
buttons = ["select", "start"]
hold_ms = 1000
device_match = "Sunshine"
EOF
  if [[ -n "$SGDB" ]]; then printf '\n[art]\nsteamgriddb_key = %s\n' "$(tq "$SGDB")"; fi
  # Mantém login do RetroAchievements e as listas exclude/rename de uma config antiga.
  if [[ -f "$CONFIG" ]]; then
    awk '/^\[/ { keep = ($0 ~ /^\[(retroachievements|library|library\.rename)\]$/) } keep' "$CONFIG" | sed '1s/^/\n/'
  fi
  emu_block pcsx2 "$PCSX2_ON" "PlayStation 2" '["flatpak", "run", "net.pcsx2.PCSX2"]' '["-bigpicture", "-fullscreen"]' \
    '["-fullscreen", "-nogui", "--", "{rom}"]' "[$(tq "$ROM_PS")]" '["iso", "chd", "cso", "zso", "gz", "cue", "bin", "elf"]' ps2 "Sony - PlayStation 2"
  emu_block duckstation "$DUCK_ON" "PlayStation" "[$(tq "$DUCK")]" '["-bigpicture", "-fullscreen"]' \
    '["-fullscreen", "-nogui", "--", "{rom}"]' "[$(tq "$ROM_PS")]" '["cue", "chd", "pbp", "m3u", "iso", "bin", "ecm", "mds"]' ps1 "Sony - PlayStation"
  emu_block retroarch "$RA_ON" "RetroArch" "$RA_CMD" '["-f"]' '["{rom}"]' '[]' '[]' "" ""
  emu_block snes "$RA_ON" "Super Nintendo" "$RA_CMD" '[]' \
    "[\"-f\", \"-L\", $(tq "$CORES/snes9x_libretro.so"), \"{rom}\"]" "[$(tq "$ROM_SNES")]" '["sfc", "smc", "fig", "swc", "bs", "zip", "7z"]' \
    snes "Nintendo - Super Nintendo Entertainment System"
  emu_block n64 "$RA_ON" "Nintendo 64" "$RA_CMD" '[]' \
    "[\"-f\", \"-L\", $(tq "$CORES/mupen64plus_next_libretro.so"), \"{rom}\"]" "[$(tq "$ROM_N64")]" '["z64", "n64", "v64", "zip", "7z"]' \
    n64 "Nintendo - Nintendo 64"
}
if (( CHECK_ONLY )); then
  info "(--check) a config seria gerada com os valores acima."
elif confirm "Gravar a configuração?"; then
  mkdir -p "$CONFIG_DIR"
  [[ -f "$CONFIG" ]] && bak="$CONFIG.bak.$(date +%Y%m%d-%H%M%S)" && cp "$CONFIG" "$bak" && chmod 600 "$bak" && info "cópia da anterior: $CONFIG.bak.*"
  tmp=$(mktemp "$CONFIG_DIR/.config.XXXXXX")
  chmod 600 "$tmp"
  gen_config >"$tmp" && mv "$tmp" "$CONFIG" && chmod 600 "$CONFIG" && ok "config gravada (permissão 600)"
fi

# ----------------------------------------------------- instalar o tvgames --

step "9. Instalar o tvgames e a API para a TV"
TVG="$HOME/.cargo/bin/tvgames"
if have cargo && ! (( CHECK_ONLY )) && confirm "Compilar e instalar o tvgames (cargo install, leva alguns minutos)?"; then
  cargo install --path "$REPO" --locked && ok "instalado em $TVG"
elif [[ -x "$TVG" ]]; then ok "tvgames já instalado em $TVG"
else fail "tvgames ainda não instalado (cargo install --path $REPO)"; fi

UNIT="$HOME/.config/systemd/user/tvgames-serve.service"
if [[ -f "$UNIT" ]] && systemctl --user is-active --quiet tvgames-serve 2>/dev/null; then
  ok "serviço tvgames-serve ativo"
  (( CHECK_ONLY )) || systemctl --user restart tvgames-serve
elif ! (( CHECK_ONLY )) && [[ -x "$TVG" ]] && confirm "Criar e ligar o serviço da API (porta $API_PORT, inicia junto com o login)?"; then
  mkdir -p "$(dirname "$UNIT")"
  cat >"$UNIT" <<EOF
[Unit]
Description=TVGames API para o app da TV
After=network-online.target

[Service]
ExecStart=%h/.cargo/bin/tvgames serve --bind 0.0.0.0:$API_PORT
Restart=on-failure

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload && systemctl --user enable --now tvgames-serve && ok "serviço tvgames-serve ligado"
else
  warn "serviço tvgames-serve não configurado"
fi

# ------------------------------------------------------------ app da TV --

step "10. App da TV"
API_KT="$REPO/tv-app/app/src/main/java/dev/tvgames/tv/Api.kt"
if [[ -n "$PC_IP" && -f "$API_KT" ]]; then
  cur_host=$(grep -o 'DEFAULT_HOST = "[^"]*"' "$API_KT" | cut -d'"' -f2)
  if [[ "$cur_host" == "$PC_IP" ]]; then ok "o app já procura o PC em $PC_IP"
  elif ! (( CHECK_ONLY )); then
    sed -i "s/DEFAULT_HOST = \"[^\"]*\"/DEFAULT_HOST = \"$PC_IP\"/" "$API_KT" && ok "app ajustado para procurar o PC em $PC_IP (antes: $cur_host)"
  else info "o app procura o PC em $cur_host; seria trocado para $PC_IP"; fi
fi
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}
JV=$(java -version 2>&1 | awk -F'"' '/version/ {split($2,a,"."); print a[1]}')
if [[ -d "$SDK" && "${JV:-0}" -ge 21 ]]; then
  ok "Android SDK ($SDK) e JDK $JV"
  [[ -f "$REPO/tv-app/local.properties" ]] || { (( CHECK_ONLY )) || echo "sdk.dir=$SDK" >"$REPO/tv-app/local.properties"; }
  if ! (( CHECK_ONLY )) && confirm "Compilar o app da TV${TV_IP:+ e instalar na TV ($TV_IP)}?"; then
    if (cd "$REPO/tv-app" && ./gradlew -q assembleRelease); then
      APK="$REPO/tv-app/app/build/outputs/apk/release/app-release.apk"
      ok "APK: $APK"
      if [[ -n "$TV_IP" ]] && have adb; then
        adb -s "$TV_IP:5555" install -r "$APK" && ok "app TVGames instalado na TV"
      fi
    else fail "falha ao compilar o app da TV"; fi
  fi
else
  warn "para compilar o app da TV precisa de JDK 21+ e Android SDK (Android Studio instala os dois)"
  info "depois: cd tv-app && ./gradlew assembleRelease && adb install -r app/build/outputs/apk/release/app-release.apk"
fi

# ---------------------------------------------------------- verificação --

step "11. Verificação final"
if [[ -x "$TVG" && -f "$CONFIG" ]] && ! (( CHECK_ONLY )); then
  "$TVG" doctor || true
  if confirm "Publicar os jogos no Sunshine agora (tvgames sync)?"; then
    "$TVG" sync && ok "jogos publicados"
  fi
fi

printf '\n%s== Resumo ==%s\n' "$B" "$N"
cat <<EOF
  PC:            ${PC_IP:-?}  (a TV acessa a API em http://${PC_IP:-<ip-do-pc>}:$API_PORT)
  TV:            ${TV_IP:-não definida}
  Tela do jogo:  $DISP_OUT em $DISP_MODE
  Config:        $CONFIG

  Onde colocar os jogos:
    Super Nintendo   $ROM_SNES   (.sfc .smc .zip ...)
    Nintendo 64      $ROM_N64   (.z64 .n64 .zip ...)
    PS1 e PS2        $ROM_PS   (.iso .chd .bin/.cue ...; o console é detectado sozinho)
    Capas próprias   $COVERS   (opcional: <nome-da-rom>.png)
    Jogos de PC      instale pela Steam, Heroic ou Hydra; aparecem sozinhos.

  Depois de colocar ou instalar jogos novos: tvgames sync
EOF
if (( FAILS > 0 )); then
  printf '\n%s%d item(ns) faltando%s e %d aviso(s). Resolva os itens [falta] acima e rode ./setup.sh de novo.\n' "$R" "$FAILS" "$N" "$WARNS"
  exit 1
fi
printf '\n%sPronto para jogar!%s Abra o app TVGames na TV e escolha um jogo.' "$G" "$N"
(( WARNS > 0 )) && printf ' (%d aviso(s) acima, nenhum impede o uso)' "$WARNS"
echo
