<#
Gera, assina e instala o Play TV (dist\TVGames.wgt) direto na TV Samsung, sem o Apps2Samsung.

Pré-requisitos (uma vez só):
  - Tizen Studio CLI em C:\tizen-studio (web-cli_Tizen_Studio_*_windows-64.exe --accept-license C:\tizen-studio)
  - perfil de segurança "PlayTV" no Tizen CLI, criado a partir do certificado Partner do Apps2Samsung
  - TV em modo desenvolvedor com o IP deste PC como host

Uso (PowerShell, nesta pasta):
  powershell -ExecutionPolicy Bypass -File .\install-tv.ps1 [-TvIp 192.168.2.102] [-SkipBuild] [-NoLaunch]
#>
param(
    [string]$TvIp = '192.168.2.102',
    [int]$TvPort = 26101,
    [string]$TizenStudio = 'C:\tizen-studio',
    [string]$SecProfile = 'PlayTV',
    [string]$AppId = 'TVGamesApp.MoonlightWasm',
    [switch]$SkipBuild,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Sdb = Join-Path $TizenStudio 'tools\sdb.exe'
$Tizen = Join-Path $TizenStudio 'tools\ide\bin\tizen.bat'
$Target = "${TvIp}:$TvPort"

function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host "ERRO: $msg" -ForegroundColor Red; exit 1 }

# Runs a native tool, echoes its output and returns it as one string.
function Invoke-Tool([string]$exe, [string[]]$arguments) {
    # Native tools write progress to stderr; don't let that become a terminating error.
    $ErrorActionPreference = 'Continue'
    $out = & $exe @arguments 2>&1 | ForEach-Object { "$_" }
    $text = ($out -join "`n")
    if ($text) { Write-Host $text }
    return @{ Code = $LASTEXITCODE; Text = $text }
}

foreach ($tool in @($Sdb, $Tizen)) {
    if (-not (Test-Path $tool)) { Fail "não achei $tool (instale o Tizen Studio CLI em $TizenStudio ou use -TizenStudio)" }
}

# (a) Build the unsigned package.
$wgt = Join-Path $Here 'dist\TVGames.wgt'
if (-not $SkipBuild) {
    Step 'gerando dist\TVGames.wgt'
    & (Join-Path $Here 'build.ps1')
    if (-not $?) { Fail 'build.ps1 falhou' }
}
if (-not (Test-Path $wgt)) { Fail "não achei $wgt (rode sem -SkipBuild)" }

# (b) Sign: unpack into a temp folder and let the Tizen CLI package it with the profile.
Step "assinando com o perfil '$SecProfile'"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("playtv-" + [guid]::NewGuid().ToString('N'))
$src = Join-Path $tmp 'src'
$outDir = Join-Path $tmp 'out'
New-Item -ItemType Directory -Force -Path $src, $outDir | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($wgt, $src)
Get-ChildItem $src -Filter '*signature*.xml' | Remove-Item -Force

$r = Invoke-Tool $Tizen @('package', '-t', 'wgt', '-s', $SecProfile, '-o', $outDir, '--', $src)
$signed = Get-ChildItem $outDir -Filter '*.wgt' | Select-Object -First 1
if ($r.Code -ne 0 -or -not $signed) { Fail 'o tizen package não gerou o .wgt assinado' }
# The CLI names the file after <name> ("Play TV.wgt"); the TV installer rejects paths with spaces.
$signed = Rename-Item $signed.FullName 'TVGames.wgt' -PassThru
$names = [IO.Compression.ZipFile]::OpenRead($signed.FullName)
try { $hasSig = @($names.Entries | Where-Object { $_.FullName -eq 'author-signature.xml' -or $_.FullName -eq 'signature1.xml' }).Count -eq 2 }
finally { $names.Dispose() }
if (-not $hasSig) { Fail "o pacote $($signed.FullName) saiu sem assinatura" }
Write-Host "assinado: $($signed.FullName)" -ForegroundColor Green

$connected = $false
try {
    # (c) Connect and install.
    Step "conectando na TV $Target"
    $r = Invoke-Tool $Sdb @('connect', $Target)
    if ($r.Text -notmatch 'connected to') { Fail "não conectou na TV (modo desenvolvedor ligado com o IP deste PC? TV ligada?)" }
    $connected = $true

    $line = (& $Sdb devices 2>&1 | ForEach-Object { "$_" }) | Where-Object { $_ -match [regex]::Escape($Target) } | Select-Object -First 1
    if (-not $line -or $line -notmatch '\bdevice\b') { Fail "a TV não aparece como 'device' no sdb devices: $line" }
    $serial = ($line -split '\s+')[-1]
    Write-Host "TV: $serial"

    Step "instalando $AppId"
    $r = Invoke-Tool $Tizen @('install', '-n', $signed.FullName, '-t', $serial)
    $ok = $r.Text -match '(?i)successfully installed|install completed'
    if (-not $ok -or $r.Text -match '(?i)install failed|\[error\]') {
        Write-Host 'tizen install não confirmou; tentando sdb install...' -ForegroundColor Yellow
        $r = Invoke-Tool $Sdb @('-s', $Target, 'install', $signed.FullName)
        $ok = $r.Text -match '(?i)install completed' -and $r.Text -notmatch '(?i)install failed|error'
    }
    if (-not $ok) { Fail 'a instalação falhou (veja a saída acima)' }
    Write-Host 'instalado!' -ForegroundColor Green

    # (d) Launch.
    if (-not $NoLaunch) {
        Step "abrindo $AppId na TV"
        $r = Invoke-Tool $Sdb @('-s', $Target, 'shell', '0', 'was_execute', $AppId)
        if ($r.Text -match '(?i)fail|error') {
            $r = Invoke-Tool $Tizen @('run', '-p', $AppId, '-t', $serial)
        }
    }
}
finally {
    # (e) Always disconnect and clean up.
    if ($connected) { & $Sdb disconnect $Target 2>&1 | Out-Null }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'pronto.' -ForegroundColor Green
