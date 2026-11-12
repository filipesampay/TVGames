#!/usr/bin/env bash
# Builds dist/TVGames.wgt: the official Moonlight Tizen release with the TVGames
# card library added (tvgames.js/css) and its own app id/name/icon, so it installs
# next to a regular Moonlight. The package is unsigned: install it with
# Apps2Samsung ("Custom WGT File"), which signs it for your TV.
set -euo pipefail

MOONLIGHT_VERSION="${MOONLIGHT_VERSION:-v1.20.0}"   # tvgames.js hooks are written against this version
URL="https://github.com/brightcraft/moonlight-tizen/releases/download/$MOONLIGHT_VERSION/Moonlight.wgt"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$HERE/.cache"; WORK="$HERE/.work"; DIST="$HERE/dist"
SRC_WGT="${1:-$CACHE/Moonlight-$MOONLIGHT_VERSION.wgt}"

for c in curl unzip zip sed; do command -v "$c" >/dev/null || { echo "falta o comando: $c" >&2; exit 1; }; done
mkdir -p "$CACHE" "$DIST"
if [[ ! -f "$SRC_WGT" ]]; then
  echo "baixando Moonlight Tizen $MOONLIGHT_VERSION..."
  curl -fL --retry 3 -o "$SRC_WGT.part" "$URL" && mv "$SRC_WGT.part" "$SRC_WGT"
fi

rm -rf "$WORK"; mkdir -p "$WORK"
unzip -q "$SRC_WGT" -d "$WORK"
[[ -f "$WORK/index.html" && -f "$WORK/config.xml" && -f "$WORK/platform/index.js" ]] || { echo "pacote inesperado: $SRC_WGT" >&2; exit 1; }

# Old signatures are invalid after the changes; Apps2Samsung signs again.
rm -f "$WORK"/author-signature.xml "$WORK"/signature*.xml

cp "$HERE/tvgames.js" "$WORK/platform/tvgames.js"
cp "$HERE/tvgames.css" "$WORK/platform/tvgames.css"
cp -r "$HERE/fonts" "$HERE/sounds" "$WORK/platform/"
cp "$HERE/icon.png" "$WORK/icon.png"

# Stylesheet in <head> and the Play TV splash right after <body> (shown before
# any script runs, in place of Moonlight's loading screen); the script at the end.
SPLASH='<div id="playtv-splash"><div class="pts-logo"><div class="pts-play">PL<span>&#923;</span>Y</div><div class="pts-line"></div><div class="pts-tv">TV</div></div><div class="pts-bar"><i></i></div><div class="pts-credit">Streaming com tecnologia Moonlight (GPL-3.0)</div></div>'
if ! grep -q 'platform/tvgames.js' "$WORK/index.html"; then
  sed -i 's|</head>|  <link rel="stylesheet" href="platform/tvgames.css">\n</head>|' "$WORK/index.html"
  sed -i "0,/<body[^>]*>/s|<body[^>]*>|&\n  ${SPLASH//&/\\&}|" "$WORK/index.html"
  sed -i 's|</body>|  <script defer src="platform/tvgames.js"></script>\n</body>|' "$WORK/index.html"
fi
for want in 'platform/tvgames.js' 'platform/tvgames.css' 'id="playtv-splash"'; do
  grep -q "$want" "$WORK/index.html" || { echo "não consegui alterar o index.html ($want)" >&2; exit 1; }
done

sed -i \
  -e 's|id="http://samsung.tv/MoonlightWasm"|id="http://tvgames.dev/TVGames"|' \
  -e 's|package="MoonLightS"|package="TVGamesApp"|' \
  -e 's|MoonLightS\.|TVGamesApp.|g' \
  -e 's|<name>Moonlight</name>|<name>Play TV</name>|' \
  -e 's|<description>Moonlight Game Streaming</description>|<description>Play TV (Moonlight Game Streaming)</description>|' \
  "$WORK/config.xml"
grep -q 'package="TVGamesApp"' "$WORK/config.xml" && ! grep -q 'MoonLightS' "$WORK/config.xml" || { echo "não consegui alterar o config.xml" >&2; exit 1; }

# Moonlight's texts ("Sair do Moonlight", ...) say Play TV instead: only the
# translated values change, the keys stay as Moonlight's code looks them up.
for f in "$WORK"/static/locales/*.json; do
  perl -pi -e 's/^(\s*"(?:[^"\\]|\\.)*"\s*:\s*)(".*)$/my ($k, $v) = ($1, $2); $v =~ s#Moonlight#Play TV#g; "$k$v"/e' "$f"
done
grep -q '"Exit Moonlight": "Sair do Play TV"' "$WORK/static/locales/pt-BR.json" || { echo "não consegui trocar os textos do Moonlight" >&2; exit 1; }

rm -f "$DIST/TVGames.wgt"
(cd "$WORK" && zip -qr -X "$DIST/TVGames.wgt" .)
rm -rf "$WORK"
echo "pronto: $DIST/TVGames.wgt"
echo "instale com o Apps2Samsung: Configurações > Release: Custom WGT File > escolha este arquivo."
