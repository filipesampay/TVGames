<#
Gera dist\TVGames.wgt (app "Play TV"): o Moonlight Tizen oficial com a tela do
Play TV (tvgames.js/css, fontes, sons) e nome/ícone/id próprios, para instalar ao lado de um
Moonlight normal. O pacote sai sem assinatura: instale com o Apps2Samsung
("Custom WGT File"), que assina para a sua TV.

Uso (PowerShell, nesta pasta):
  powershell -ExecutionPolicy Bypass -File .\build.ps1
#>
param([string]$SourceWgt = '')

$ErrorActionPreference = 'Stop'
$MoonlightVersion = 'v1.20.0'   # os ganchos do tvgames.js foram escritos para esta versão
$Url = "https://github.com/brightcraft/moonlight-tizen/releases/download/$MoonlightVersion/Moonlight.wgt"
$Here = $PSScriptRoot
$Cache = Join-Path $Here '.cache'
$Work = Join-Path $Here '.work'
$Dist = Join-Path $Here 'dist'
if (-not $SourceWgt) { $SourceWgt = Join-Path $Cache "Moonlight-$MoonlightVersion.wgt" }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force -Path $Cache, $Dist | Out-Null

if (-not (Test-Path $SourceWgt)) {
    Write-Host "baixando Moonlight Tizen $MoonlightVersion..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile "$SourceWgt.part" -UseBasicParsing
    Move-Item "$SourceWgt.part" $SourceWgt -Force
}

if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
[IO.Compression.ZipFile]::ExtractToDirectory($SourceWgt, $Work)
foreach ($f in @('index.html', 'config.xml', 'platform\index.js')) {
    if (-not (Test-Path (Join-Path $Work $f))) { throw "pacote inesperado: $SourceWgt (falta $f)" }
}

# As assinaturas antigas deixam de valer; o Apps2Samsung assina de novo.
Get-ChildItem $Work -Filter '*signature*.xml' | Remove-Item -Force

Copy-Item (Join-Path $Here 'tvgames.js') (Join-Path $Work 'platform\tvgames.js') -Force
Copy-Item (Join-Path $Here 'tvgames.css') (Join-Path $Work 'platform\tvgames.css') -Force
Copy-Item (Join-Path $Here 'fonts') (Join-Path $Work 'platform') -Recurse -Force
Copy-Item (Join-Path $Here 'sounds') (Join-Path $Work 'platform') -Recurse -Force
Copy-Item (Join-Path $Here 'icon.png') (Join-Path $Work 'icon.png') -Force

$utf8 = New-Object Text.UTF8Encoding $false
$index = Join-Path $Work 'index.html'
$html = [IO.File]::ReadAllText($index)
# Folha de estilo no <head>, a tela de abertura do Play TV logo depois do <body>
# (aparece antes de qualquer script, no lugar do carregamento do Moonlight) e o script no fim.
$splash = '<div id="playtv-splash"><div class="pts-logo"><div class="pts-play">PL<span>&#923;</span>Y</div><div class="pts-line"></div><div class="pts-tv">TV</div></div><div class="pts-bar"><i></i></div><div class="pts-credit">Streaming com tecnologia Moonlight (GPL-3.0)</div></div>'
if ($html -notmatch 'platform/tvgames.js') {
    $html = $html.Replace('</head>', "  <link rel=`"stylesheet`" href=`"platform/tvgames.css`">`n</head>")
    $html = ([regex]'<body[^>]*>').Replace($html, { param($m) $m.Value + "`n  " + $splash }, 1)
    $html = $html.Replace('</body>', "  <script defer src=`"platform/tvgames.js`"></script>`n</body>")
    [IO.File]::WriteAllText($index, $html, $utf8)
}
$check = [IO.File]::ReadAllText($index)
foreach ($want in @('platform/tvgames.js', 'platform/tvgames.css', 'id="playtv-splash"')) {
    if (-not $check.Contains($want)) { throw "não consegui alterar o index.html ($want)" }
}

$configPath = Join-Path $Work 'config.xml'
$cfg = [IO.File]::ReadAllText($configPath)
$cfg = $cfg.Replace('id="http://samsung.tv/MoonlightWasm"', 'id="http://tvgames.dev/TVGames"')
$cfg = $cfg.Replace('package="MoonLightS"', 'package="TVGamesApp"')
$cfg = $cfg.Replace('MoonLightS.', 'TVGamesApp.')
$cfg = $cfg.Replace('<name>Moonlight</name>', '<name>Play TV</name>')
$cfg = $cfg.Replace('<description>Moonlight Game Streaming</description>', '<description>Play TV (Moonlight Game Streaming)</description>')
if ($cfg -notmatch 'package="TVGamesApp"' -or $cfg -match 'MoonLightS') { throw 'não consegui alterar o config.xml' }
[IO.File]::WriteAllText($configPath, $cfg, $utf8)

# Os textos do Moonlight ("Sair do Moonlight", ...) passam a dizer Play TV: só os
# valores traduzidos mudam, as chaves continuam como o código do Moonlight procura.
$lineRx = [regex]'(?m)^(\s*"(?:[^"\\]|\\.)*"\s*:\s*)(".*)$'
foreach ($loc in Get-ChildItem (Join-Path $Work 'static\locales') -Filter '*.json') {
    $text = [IO.File]::ReadAllText($loc.FullName)
    $text = $lineRx.Replace($text, { param($m) $m.Groups[1].Value + $m.Groups[2].Value.Replace('Moonlight', 'Play TV') })
    [IO.File]::WriteAllText($loc.FullName, $text, $utf8)
}
if (-not ([IO.File]::ReadAllText((Join-Path $Work 'static\locales\pt-BR.json'))).Contains('"Exit Moonlight": "Sair do Play TV"')) {
    throw 'não consegui trocar os textos do Moonlight'
}

# Zip com "/" nos caminhos (o Compress-Archive do PowerShell 5.1 usa "\", que a TV não aceita).
$out = Join-Path $Dist 'TVGames.wgt'
if (Test-Path $out) { Remove-Item $out -Force }
$zip = [IO.Compression.ZipFile]::Open($out, [IO.Compression.ZipArchiveMode]::Create)
try {
    $prefix = (Resolve-Path $Work).Path.TrimEnd('\') + '\'
    foreach ($file in Get-ChildItem $Work -Recurse -File) {
        $name = $file.FullName.Substring($prefix.Length).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
    }
} finally {
    $zip.Dispose()
}
Remove-Item $Work -Recurse -Force
Write-Host "pronto: $out" -ForegroundColor Green
Write-Host 'instale com o Apps2Samsung: Configurações > Release: Custom WGT File > escolha este arquivo.'
