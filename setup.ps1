<#
TVGames: instalação guiada no Windows.

Verifica o que falta, descobre/pergunta os IPs, libera as portas no Firewall do
Windows, define onde ficam os jogos, gera %APPDATA%\tvgames\config.toml, instala
o tvgames e a API (inicia sozinha no login), prepara o app da TV e, no fim, roda
`tvgames doctor` e `tvgames sync` para deixar tudo pronto para jogar.

Uso (no PowerShell, dentro da pasta do projeto):
  powershell -ExecutionPolicy Bypass -File .\setup.ps1          instalação interativa
  powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Check   só verifica, sem alterar nada

Pode ser rodado de novo quando quiser: ele mostra os valores atuais como padrão.
#>
param([switch]$Check)

$ErrorActionPreference = 'Continue'
$Repo = $PSScriptRoot
# A ready-made tvgames.exe next to this script skips Rust and the C++ Build Tools.
$Prebuilt = Join-Path $Repo 'tvgames.exe'
$HasPrebuilt = Test-Path $Prebuilt
$ConfigDir = Join-Path $env:APPDATA 'tvgames'
$Config = Join-Path $ConfigDir 'config.toml'
$ApiPort = 47900
$TcpPorts = @(47984, 47989, 48010, $ApiPort)
$UdpPorts = @(47998, 47999, 48000, 48002, 48010, 5353)
$script:Fails = 0
$script:Warns = 0

# ------------------------------------------------------------------ helpers --

function Step($t) { Write-Host ''; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok($t) { Write-Host '  [ok]    ' -ForegroundColor Green -NoNewline; Write-Host $t }
function Warn($t) { Write-Host '  [aviso] ' -ForegroundColor Yellow -NoNewline; Write-Host $t; $script:Warns++ }
function Fail($t) { Write-Host '  [falta] ' -ForegroundColor Red -NoNewline; Write-Host $t; $script:Fails++ }
function Info($t) { Write-Host "          $t" }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

function Ask($q, $def) {
    if ($Check) { return $def }
    if ($def) { $a = Read-Host "  $q [$def]" } else { $a = Read-Host "  $q" }
    if ([string]::IsNullOrWhiteSpace($a)) { return $def }
    return $a.Trim()
}

function AskSecret($q, $def) {
    if ($Check) { return $def }
    $hint = if ($def) { ' [Enter mantém a atual]' } else { '' }
    $s = Read-Host "  $q$hint" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    if ([string]::IsNullOrEmpty($plain)) { return $def }
    return $plain
}

function Confirm($q) {
    if ($Check) { return $false }
    $a = Read-Host "  $q [S/n]"
    return ([string]::IsNullOrWhiteSpace($a) -or $a -match '^[sSyY]')
}

# Valor atual de uma chave no config existente: Cur 'sunshine' 'username'
function Cur($section, $key) {
    if (-not (Test-Path $Config)) { return '' }
    $in = $false
    foreach ($line in Get-Content $Config -Encoding UTF8) {
        if ($line -match '^\[') { $in = ($line.Trim() -eq "[$section]"); continue }
        if ($in -and $line -match "^$([regex]::Escape($key))\s*=\s*(.*)$") {
            $v = $Matches[1].Trim()
            if ($v -match "^'(.*)'$") { return $Matches[1] }
            if ($v -match '^"(.*)"$') { return ($Matches[1] -replace '\\\\', '\') -replace '\\"', '"' }
            return $v
        }
    }
    return ''
}

# String TOML: literal ('...') quando possível, para caminhos com \ ficarem legíveis.
function Tq($s) {
    if ($null -eq $s) { $s = '' }
    if ($s -notmatch "'" -and $s -notmatch "[`r`n]") { return "'$s'" }
    return '"' + (($s -replace '\\', '\\') -replace '"', '\"') + '"'
}
function TList($items) { '[' + (($items | ForEach-Object { Tq $_ }) -join ', ') + ']' }

function FirstExisting($paths) {
    foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return (Resolve-Path $p).Path } }
    return $null
}

function FindExe($dirs, $pattern) {
    foreach ($d in $dirs) {
        if ($d -and (Test-Path $d)) {
            $f = Get-ChildItem -Path $d -Filter $pattern -File -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($f) { return $f.FullName }
        }
    }
    return $null
}

function IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

Write-Host 'TVGames: instalação guiada (Windows)' -ForegroundColor White
if ($Check) { Write-Host 'Modo -Check: nada será alterado.' }
if (Test-Path $Config) { Write-Host "Config existente em ${Config}: os valores atuais aparecem como padrão." }

# Firewall e tarefa agendada precisam de administrador.
if (-not $Check -and -not (IsAdmin)) {
    Write-Host ''
    Write-Host 'Algumas etapas (firewall e iniciar a API sozinha) precisam de administrador.' -ForegroundColor Yellow
    if (Confirm 'Reabrir este script como administrador?') {
        Start-Process powershell -Verb RunAs -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
        exit
    }
    Warn 'seguindo sem administrador: firewall e inicialização automática serão pulados'
}
$Admin = IsAdmin

# ----------------------------------------------------------------- sistema --

Step '1. Sistema'
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) { Ok "$($os.Caption) ($($os.Version))" } else { Ok 'Windows' }
if ($PSVersionTable.PSVersion.Major -lt 5) { Fail "PowerShell $($PSVersionTable.PSVersion) é antigo (precisa 5.1+)" }
$HasWinget = Have 'winget'

# ------------------------------------------------------------ dependências --

Step '2. Programas necessários'
function OfferWinget($id, $what) {
    if ($HasWinget -and (Confirm "Instalar $what agora com o winget ($id)?")) {
        winget install --id $id -e --accept-source-agreements --accept-package-agreements
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        return $true
    }
    return $false
}

if ($HasPrebuilt) {
    Ok 'tvgames.exe já compilado nesta pasta (não precisa de Rust nem do Visual Studio)'
} else {
    if (-not (Have 'cargo')) {
        Fail 'Rust (cargo) não encontrado: compila o tvgames. https://rustup.rs'
        if (OfferWinget 'Rustlang.Rustup' 'o Rust') { if (Have 'cargo') { Ok 'Rust instalado'; $script:Fails-- } }
    } else { Ok "cargo ($((cargo --version) -join ''))" }

    # O Rust no Windows precisa do linker do Visual Studio (C++ Build Tools).
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $hasMsvc = (Test-Path $vswhere) -and [bool](& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null)
    if ($hasMsvc) { Ok 'Visual Studio C++ Build Tools (linker do Rust)' }
    else {
        Fail 'Visual Studio C++ Build Tools não encontrado (o Rust precisa dele para compilar)'
        Info 'winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
    }
}

$SunDir = Join-Path $env:ProgramFiles 'Sunshine'
if (Test-Path (Join-Path $SunDir 'sunshine.exe')) { Ok "Sunshine instalado ($SunDir)" }
else {
    Fail 'Sunshine não encontrado: https://github.com/LizardByte/Sunshine/releases'
    if (OfferWinget 'LizardByte.Sunshine' 'o Sunshine') { if (Test-Path (Join-Path $SunDir 'sunshine.exe')) { Ok 'Sunshine instalado'; $script:Fails-- } }
}
# Without ViGEmBus, Sunshine cannot create the virtual controller: the stream works but the gamepad does nothing in games.
if (Get-Service -Name 'ViGEmBus' -ErrorAction SilentlyContinue) { Ok 'ViGEmBus (controle virtual do Sunshine)' }
else {
    Fail 'ViGEmBus não encontrado: sem ele o controle não funciona nos jogos'
    Info 'Baixe e instale: https://github.com/nefarius/ViGEmBus/releases (depois reinicie o PC)'
}
$svc = Get-Service -Name 'SunshineService' -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') { Ok 'serviço do Sunshine rodando' }
elseif ($svc) { Warn "serviço do Sunshine está $($svc.Status) (Iniciar > Serviços > SunshineService)" }
else { Warn 'serviço do Sunshine não encontrado (instale com a opção de serviço)' }

if (Have 'adb') { Ok 'adb (falar com a TV e instalar o app)' }
else {
    Warn 'adb não encontrado: usado para falar com a TV e instalar o app'
    [void](OfferWinget 'Google.PlatformTools' 'o adb (Android Platform Tools)')
}
if (-not (Have 'curl.exe')) { Warn 'curl.exe não encontrado (vem com o Windows 10/11): não dá para testar o login do Sunshine' }

# ------------------------------------------------------------------- rede --

Step '3. Rede e IPs'
$net = Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
$PcIp = if ($net) { $net.IPv4Address[0].IPAddress } else { '' }
if ($PcIp) {
    Ok "IP deste PC: $PcIp ($($net.InterfaceAlias))"
    Info 'Dica: fixe esse IP no roteador (reserva DHCP) para a TV sempre achar o PC.'
    $prof = Get-NetConnectionProfile -InterfaceIndex $net.InterfaceIndex -ErrorAction SilentlyContinue
    if ($prof -and $prof.NetworkCategory -eq 'Public') {
        Warn "a rede '$($prof.Name)' está como Pública: o Windows bloqueia a TV"
        if ($Admin -and (Confirm 'Marcar esta rede como Privada (rede de casa)?')) {
            Set-NetConnectionProfile -InterfaceIndex $net.InterfaceIndex -NetworkCategory Private
            Ok 'rede marcada como Privada'
        }
    }
} else { Fail 'não consegui descobrir o IP deste PC (está conectado à rede?)' }

$curTv = (Cur 'tv' 'adb_serial') -replace ':5555$', ''
Write-Host '  Na TV: Configurações > Rede > (sua rede) mostra o IP. Ative também a depuração ADB'
Write-Host '  (Configurações > Preferências do dispositivo > Sobre: clique 7x em Build; depois Opções do desenvolvedor).'
$TvIp = Ask 'IP da TV' $curTv
if ($TvIp) {
    if (Test-Connection -ComputerName $TvIp -Count 1 -Quiet -ErrorAction SilentlyContinue) { Ok "TV responde em $TvIp" }
    else { Warn "TV não respondeu ao ping em $TvIp (ligada? mesma rede?)" }
    if ((Have 'adb') -and -not $Check) {
        $r = (adb connect "${TvIp}:5555" 2>&1) -join ' '
        if ($r -match 'connected') {
            Ok 'ADB conectado (aceite o aviso na TV na primeira vez)'
            $pk = (adb -s "${TvIp}:5555" shell pm list packages com.limelight 2>&1) -join ' '
            if ($pk -match 'limelight') { Ok 'Moonlight instalado na TV' }
            else { Warn 'Moonlight não está na TV: instale pela Play Store da TV e pareie com este PC' }
        } else { Warn "ADB não conectou em ${TvIp}:5555 (depuração ADB ligada na TV?)" }
    }
} else { Warn 'IP da TV em branco: comandos "tvgames tv" e instalação do app pelo PC não vão funcionar' }

# --------------------------------------------------------------- Sunshine --

Step '4. Sunshine'
$SunUrl = Cur 'sunshine' 'url'; if (-not $SunUrl) { $SunUrl = 'https://localhost:47990' }
Info "Usuário e senha são os do painel web ($SunUrl). Se nunca abriu, abra agora e crie."
$SunUser = Ask 'Usuário do painel web do Sunshine' (Cur 'sunshine' 'username')
$SunPass = AskSecret 'Senha do painel web do Sunshine' (Cur 'sunshine' 'password')
if ($SunUser -and $SunPass -and (Have 'curl.exe')) {
    $code = (curl.exe -sk -o NUL -w '%{http_code}' -u "${SunUser}:${SunPass}" "$SunUrl/api/apps") -join ''
    switch ($code) {
        '200' { Ok "login no Sunshine funcionou ($SunUrl)" }
        '401' { Fail "Sunshine recusou usuário/senha (confira em $SunUrl)" }
        '000' { Fail "Sunshine não respondeu em $SunUrl (o serviço está rodando?)" }
        default { Warn "Sunshine respondeu HTTP $code" }
    }
} elseif (-not ($SunUser -and $SunPass)) { Fail 'usuário/senha do Sunshine em branco' }

# -------------------------------------------------------------------- tela --

Step '5. Tela que vai para a TV'
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
foreach ($s in $screens) {
    $p = if ($s.Primary) { ' (principal)' } else { '' }
    Info "$($s.DeviceName)  $($s.Bounds.Width)x$($s.Bounds.Height)$p"
}
$DispOut = Cur 'display' 'output'
$DispMode = Cur 'display' 'mode'; if (-not $DispMode) { $DispMode = '1920x1080@60' }
if ($screens.Count -le 1) {
    Ok 'só uma tela: o jogo vai nela e o tvgames não mexe nas telas'
    $DispOut = ''
} else {
    Info 'Com mais de uma tela, o tvgames deixa a tela da TV como principal durante o jogo.'
    Info 'Escolha a mesma tela que o Sunshine transmite (painel do Sunshine > Audio/Video). Enter vazio = não mexer.'
    $DispOut = Ask 'Tela que vai para a TV (ex.: \\.\DISPLAY2)' $DispOut
    if ($DispOut) {
        if (-not ($screens | Where-Object { $_.DeviceName -eq $DispOut })) { Warn "a tela $DispOut não existe agora" }
        $DispMode = Ask 'Resolução durante o jogo (LxA@Hz)' $DispMode
    }
}

# ------------------------------------------------------------------- jogos --

Step '6. Onde ficam os jogos'
$SteamRoot = Cur 'steam' 'root'
if (-not $SteamRoot) {
    $SteamRoot = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction SilentlyContinue).SteamPath
    if ($SteamRoot) { $SteamRoot = $SteamRoot -replace '/', '\' } else { $SteamRoot = "${env:ProgramFiles(x86)}\Steam" }
}
$SteamOn = Test-Path (Join-Path $SteamRoot 'steamapps')
if ($SteamOn) { Ok "Steam: $SteamRoot (jogos instalados pela Steam entram sozinhos)" } else { Warn "Steam não encontrada em $SteamRoot (desativada)" }

$HeroicDir = Join-Path $env:APPDATA 'heroic'
$HeroicBin = FirstExisting @((Cur 'heroic' 'binary'), "$env:LOCALAPPDATA\Programs\heroic\Heroic.exe", "$env:ProgramFiles\Heroic\Heroic.exe")
$HeroicOn = [bool]$HeroicBin -and (Test-Path $HeroicDir)
if ($HeroicOn) { Ok "Heroic: $HeroicBin (jogos Epic e adicionados manualmente entram sozinhos)" }
else { $HeroicBin = "$env:LOCALAPPDATA\Programs\heroic\Heroic.exe"; Info 'Heroic não encontrado (desativado)' }

$HydraDir = Join-Path $env:APPDATA 'hydralauncher\hydra-db'
$HydraOn = Test-Path $HydraDir
if ($HydraOn) { Ok "Hydra: $HydraDir (cada jogo precisa ter o executável escolhido no Hydra)" } else { Info 'Hydra não encontrado (desativado)' }

Write-Host ''
Write-Host '  Os jogos de emulador (ROMs) ficam todos numa pasta base, com uma subpasta por console:'
$curSnes = ''
if (Test-Path $Config) {
    $m = Select-String -Path $Config -Pattern "^rom_dirs = \[['""](.+?)['""]" -Encoding UTF8 | Where-Object { $_.Line -match 'snes' } | Select-Object -First 1
    if ($m) { $curSnes = $m.Matches[0].Groups[1].Value -replace '\\\\', '\' }
}
$defRoms = if ($curSnes) { Split-Path $curSnes -Parent } else { Join-Path $HOME 'Jogos\Roms' }
$Roms = (Ask 'Pasta base das ROMs' $defRoms).TrimEnd('\')
$RomSnes = Join-Path $Roms 'snes'; $RomN64 = Join-Path $Roms 'n64'
$RomPs = Join-Path $Roms 'playstation'; $Covers = Join-Path $Roms 'capas'
if (-not $Check) {
    try {
        foreach ($d in @($RomSnes, $RomN64, $RomPs, $Covers)) { New-Item -ItemType Directory -Force -Path $d -ErrorAction Stop | Out-Null }
        Ok "pastas criadas em $Roms"
    } catch { Fail "não consegui criar $Roms ($($_.Exception.Message))" }
}

Write-Host ''
Write-Host '  Emuladores (Enter vazio = pular):'
$Pcsx2 = FirstExisting @("$env:ProgramFiles\PCSX2\pcsx2-qt.exe", "$env:LOCALAPPDATA\Programs\PCSX2\pcsx2-qt.exe")
if (-not $Pcsx2) { $Pcsx2 = FindExe @("$HOME\Emuladores", "$HOME\Downloads") 'pcsx2-qt*.exe' }
if ($Pcsx2) { Ok "PCSX2 (PS2): $Pcsx2" } else {
    $Pcsx2 = Ask 'Caminho do pcsx2-qt.exe (baixe em https://pcsx2.net)' ''
    if ($Pcsx2 -and -not (Test-Path $Pcsx2)) { Warn "não existe: $Pcsx2"; $Pcsx2 = '' }
    if (-not $Pcsx2) { Warn 'PCSX2 não configurado: jogos de PS2 ficam de fora' }
}
$Duck = FindExe @("$HOME\Emuladores", "$env:ProgramFiles\DuckStation", "$env:LOCALAPPDATA\Programs\DuckStation", "$HOME\Downloads") 'duckstation-qt*.exe'
if ($Duck) { Ok "DuckStation (PS1): $Duck" } else {
    $Duck = Ask 'Caminho do duckstation-qt-x64-ReleaseLTCG.exe (baixe em https://www.duckstation.org)' ''
    if ($Duck -and -not (Test-Path $Duck)) { Warn "não existe: $Duck"; $Duck = '' }
    if (-not $Duck) { Warn 'DuckStation não configurado: jogos de PS1 ficam de fora' }
}
$Ra = FirstExisting @('C:\RetroArch-Win64\retroarch.exe', "$env:ProgramFiles\RetroArch\retroarch.exe", "$env:APPDATA\RetroArch\retroarch.exe")
if (-not $Ra) { $Ra = FindExe @("$HOME\Emuladores") 'retroarch.exe' }
if ($Ra) { Ok "RetroArch (SNES e N64): $Ra" } else {
    $Ra = Ask 'Caminho do retroarch.exe (baixe em https://www.retroarch.com)' ''
    if ($Ra -and -not (Test-Path $Ra)) { Warn "não existe: $Ra"; $Ra = '' }
    if (-not $Ra) { Warn 'RetroArch não configurado: jogos de SNES e N64 ficam de fora' }
}
$Cores = if ($Ra) { Join-Path (Split-Path $Ra -Parent) 'cores' } else { 'C:\RetroArch-Win64\cores' }
if ($Ra) {
    foreach ($core in @('snes9x', 'mupen64plus_next')) {
        if (-not (Test-Path (Join-Path $Cores "${core}_libretro.dll"))) { Warn "núcleo $core não baixado: no RetroArch, Menu principal > Baixar núcleos > $core" }
    }
}

# ---------------------------------------------------------------- firewall --

Step '7. Firewall do Windows (portas que a TV precisa acessar neste PC)'
Info "TCP: $($TcpPorts -join ', ')   (47984/47989/48010 Sunshine, $ApiPort API do TVGames)"
Info "UDP: $($UdpPorts -join ', ')   (vídeo/áudio/controle do Sunshine, 5353 descoberta mDNS)"
Info 'A porta 47990 (painel web do Sunshine) NÃO precisa ser aberta para a rede.'
$ruleTcp = Get-NetFirewallRule -DisplayName 'TVGames (TCP)' -ErrorAction SilentlyContinue
$ruleUdp = Get-NetFirewallRule -DisplayName 'TVGames (UDP)' -ErrorAction SilentlyContinue
if ($ruleTcp -and $ruleUdp) { Ok 'regras "TVGames" já existem no firewall' }
elseif ($Admin -and (Confirm 'Criar as regras no Firewall do Windows (só redes privadas)?')) {
    if ($ruleTcp) { Remove-NetFirewallRule -DisplayName 'TVGames (TCP)' }
    if ($ruleUdp) { Remove-NetFirewallRule -DisplayName 'TVGames (UDP)' }
    New-NetFirewallRule -DisplayName 'TVGames (TCP)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $TcpPorts -Profile Private, Domain | Out-Null
    New-NetFirewallRule -DisplayName 'TVGames (UDP)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort $UdpPorts -Profile Private, Domain | Out-Null
    Ok 'portas liberadas'
} else {
    Warn 'regras do firewall não criadas (rode como administrador)'
}

# ------------------------------------------------------------------ config --

Step "8. Configuração ($Config)"
$Sgdb = Cur 'art' 'steamgriddb_key'
$SteamKey = Cur 'steam' 'api_key'
$Legendary = Cur 'epic' 'legendary'
if (-not $Legendary) { $Legendary = Join-Path $env:LOCALAPPDATA 'tvgames\bin\legendary.exe' }
function EmuBlock($key, $enabled, $name, $cmd, $front, $romArgs, $dirs, $exts, $platform, $thumbs) {
    $b = "`n[emulators.$key]`nenabled = $enabled`nname = $(Tq $name)`ncommand = $(TList $cmd)`nfrontend_args = $(TList $front)`nrom_args = $(TList $romArgs)`nrom_dirs = $(TList $dirs)`nextensions = $(TList $exts)`n"
    if ($platform) { $b += "platform = $(Tq $platform)`n" }
    if ($thumbs) { $b += "thumbnails = $(Tq $thumbs)`n" }
    if ($dirs.Count -gt 0) { $b += "covers_dir = $(Tq $Covers)`n" }
    return $b
}
function Bool($b) { if ($b) { 'true' } else { 'false' } }
$tvSerial = if ($TvIp) { "${TvIp}:5555" } else { '' }
$text = @"
# Gerado por setup.ps1 em $(Get-Date -Format 'yyyy-MM-dd HH:mm'). Pode editar à vontade; rode o setup.ps1 de novo quando quiser.

[sunshine]
url = $(Tq $SunUrl)
username = $(Tq $SunUser)
password = $(Tq $SunPass)

[display]
output = $(Tq $DispOut)
mode = $(Tq $DispMode)
make_primary = true
move_new_windows = true

[tv]
adb_serial = $(Tq $tvSerial)

[steam]
enabled = $(Bool $SteamOn)
root = $(Tq $SteamRoot)
big_picture = $(Bool $SteamOn)
# Chave da Steam Web API (steamcommunity.com/dev/apikey): aba Downloads e troféus da Steam na TV.
api_key = $(Tq $SteamKey)

[heroic]
enabled = $(Bool $HeroicOn)
config_dir = $(Tq $HeroicDir)
binary = $(Tq $HeroicBin)

[epic]
# Legendary (github.com/legendary-gl/legendary): aba Downloads da Epic na TV.
enabled = true
legendary = $(Tq $Legendary)

[hydra]
enabled = $(Bool $HydraOn)
db_dir = $(Tq $HydraDir)

[hotkey]
enabled = true
buttons = ["select", "start"]
hold_ms = 1000
device_match = "Sunshine"

"@
if ($Sgdb) { $text += "[art]`nsteamgriddb_key = $(Tq $Sgdb)`n`n" }
# Mantém login do RetroAchievements e as listas exclude/rename de uma config antiga.
if (Test-Path $Config) {
    $keep = $false
    foreach ($line in Get-Content $Config -Encoding UTF8) {
        if ($line -match '^\[') { $keep = $line.Trim() -in @('[retroachievements]', '[library]', '[library.rename]') }
        if ($keep) { $text += "$line`n" }
    }
}
$psExts = @('iso', 'chd', 'cso', 'zso', 'gz', 'cue', 'bin', 'elf')
$ps1Exts = @('cue', 'chd', 'pbp', 'm3u', 'iso', 'bin', 'ecm', 'mds')
$emuArgs = @('-fullscreen', '-nogui', '--', '{rom}')
$raCmd = if ($Ra) { @($Ra) } else { @('C:\RetroArch-Win64\retroarch.exe') }
$pcsx2Cmd = if ($Pcsx2) { @($Pcsx2) } else { @("$env:ProgramFiles\PCSX2\pcsx2-qt.exe") }
$duckCmd = if ($Duck) { @($Duck) } else { @("$HOME\Emuladores\DuckStation\duckstation-qt-x64-ReleaseLTCG.exe") }
$text += EmuBlock 'pcsx2' (Bool $Pcsx2) 'PlayStation 2' $pcsx2Cmd @('-bigpicture', '-fullscreen') $emuArgs @($RomPs) $psExts 'ps2' 'Sony - PlayStation 2'
$text += EmuBlock 'duckstation' (Bool $Duck) 'PlayStation' $duckCmd @('-bigpicture', '-fullscreen') $emuArgs @($RomPs) $ps1Exts 'ps1' 'Sony - PlayStation'
$text += EmuBlock 'retroarch' (Bool $Ra) 'RetroArch' $raCmd @('-f') @('{rom}') @() @() '' ''
$text += EmuBlock 'snes' (Bool $Ra) 'Super Nintendo' $raCmd @() @('-f', '-L', (Join-Path $Cores 'snes9x_libretro.dll'), '{rom}') @($RomSnes) @('sfc', 'smc', 'fig', 'swc', 'bs', 'zip', '7z') 'snes' 'Nintendo - Super Nintendo Entertainment System'
$text += EmuBlock 'n64' (Bool $Ra) 'Nintendo 64' $raCmd @() @('-f', '-L', (Join-Path $Cores 'mupen64plus_next_libretro.dll'), '{rom}') @($RomN64) @('z64', 'n64', 'v64', 'zip', '7z') 'n64' 'Nintendo - Nintendo 64'

if ($Check) { Info '(-Check) a config seria gerada com os valores acima.' }
elseif (Confirm 'Gravar a configuração?') {
    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    if (Test-Path $Config) {
        $bak = "$Config.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $Config $bak
        Info "cópia da anterior: $bak"
    }
    # UTF-8 sem BOM (o leitor de TOML não aceita BOM).
    [IO.File]::WriteAllText($Config, ($text -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
    Ok 'config gravada (só o seu usuário do Windows tem acesso a essa pasta)'
}

# ----------------------------------------------------- instalar o tvgames --

Step '9. Instalar o tvgames e a API para a TV'
if ($HasPrebuilt) {
    $Tvg = Join-Path $env:LOCALAPPDATA 'tvgames\bin\tvgames.exe'
    if (-not $Check) {
        # The API may be running from the old copy; stop it so the file can be replaced.
        Stop-ScheduledTask -TaskName 'TVGames API' -ErrorAction SilentlyContinue
        Get-Process tvgames -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Tvg } | Stop-Process -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path (Split-Path $Tvg) | Out-Null
        Copy-Item -Force $Prebuilt $Tvg
        Ok "tvgames copiado para $Tvg"
    } elseif (Test-Path $Tvg) { Ok "tvgames instalado em $Tvg" }
    else { Fail 'tvgames ainda não instalado (rode o setup sem -Check)' }
} else {
$Tvg = Join-Path $HOME '.cargo\bin\tvgames.exe'
if ((Have 'cargo') -and -not $Check -and (Confirm 'Compilar e instalar o tvgames (cargo install, leva alguns minutos)?')) {
    cargo install --path "$Repo" --locked
    if ($LASTEXITCODE -eq 0) { Ok "instalado em $Tvg" } else { Fail 'a compilação falhou (veja a mensagem acima)' }
} elseif (Test-Path $Tvg) { Ok "tvgames já instalado em $Tvg" }
else { Fail "tvgames ainda não instalado (cargo install --path `"$Repo`")" }
}

$TaskName = 'TVGames API'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Ok "tarefa '$TaskName' já existe (inicia a API no login)"
    if ($Admin -and -not $Check -and $task.Principal.LogonType -ne 'Interactive') {
        # Tarefas antigas rodavam como S4U (sessão 0), onde não dá para reiniciar a Steam do usuário.
        $user = "$env:USERDOMAIN\$env:USERNAME"
        Set-ScheduledTask -TaskName $TaskName -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) -Action (New-ScheduledTaskAction -Execute $Tvg -Argument "serve --bind 0.0.0.0:$ApiPort --background") | Out-Null
        Ok "tarefa '$TaskName' passou a rodar na sua sessão (aba Downloads)"
    }
    if (-not $Check) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName $TaskName }
} elseif ($Admin -and (Test-Path $Tvg) -and (Confirm "Iniciar a API sozinha no login (porta $ApiPort, sem janela)?")) {
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $action = New-ScheduledTaskAction -Execute $Tvg -Argument "serve --bind 0.0.0.0:$ApiPort --background"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    # Interactive: roda na sessão do usuário (a aba Downloads precisa fechar e abrir a Steam dele);
    # --background fecha a janela do console e grava a saída no tvgames.log.
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Ok "API configurada: tarefa agendada '$TaskName'"
} else {
    Warn "API não configurada para iniciar sozinha (rode como administrador, ou deixe aberto: tvgames serve)"
}

# ------------------------------------------------------------ app da TV --

Step '10. App da TV'
$ApiKt = Join-Path $Repo 'tv-app\app\src\main\java\dev\tvgames\tv\Api.kt'
if ($PcIp -and (Test-Path $ApiKt)) {
    $kt = [IO.File]::ReadAllText($ApiKt)
    $curHost = [regex]::Match($kt, 'DEFAULT_HOST = "([^"]*)"').Groups[1].Value
    if ($curHost -eq $PcIp) { Ok "o app já procura o PC em $PcIp" }
    elseif (-not $Check) {
        [IO.File]::WriteAllText($ApiKt, ($kt -replace 'DEFAULT_HOST = "[^"]*"', "DEFAULT_HOST = `"$PcIp`""), (New-Object Text.UTF8Encoding $false))
        Ok "app ajustado para procurar o PC em $PcIp (antes: $curHost)"
    } else { Info "o app procura o PC em $curHost; seria trocado para $PcIp" }
}
$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$javaOk = $false
if (Have 'java') {
    $jv = (& java -version 2>&1 | Select-Object -First 1) -as [string]
    if ($jv -match '"(\d+)') { $javaOk = [int]$Matches[1] -ge 21 }
}
if ((Test-Path $Sdk) -and $javaOk) {
    Ok "Android SDK ($Sdk) e JDK 21+"
    $lp = Join-Path $Repo 'tv-app\local.properties'
    if (-not (Test-Path $lp) -and -not $Check) {
        [IO.File]::WriteAllText($lp, "sdk.dir=$($Sdk -replace '\\', '\\\\')`n", (New-Object Text.UTF8Encoding $false))
    }
    $what = if ($TvIp) { " e instalar na TV ($TvIp)" } else { '' }
    if (-not $Check -and (Confirm "Compilar o app da TV$what?")) {
        Push-Location (Join-Path $Repo 'tv-app')
        & .\gradlew.bat -q assembleRelease
        $built = $LASTEXITCODE -eq 0
        Pop-Location
        if ($built) {
            $apk = Join-Path $Repo 'tv-app\app\build\outputs\apk\release\app-release.apk'
            Ok "APK: $apk"
            if ($TvIp -and (Have 'adb')) {
                adb -s "${TvIp}:5555" install -r "$apk"
                if ($LASTEXITCODE -eq 0) { Ok 'app TVGames instalado na TV' }
            }
        } else { Fail 'falha ao compilar o app da TV' }
    }
} else {
    Warn 'para compilar o app da TV precisa de JDK 21+ e Android SDK (o Android Studio instala os dois)'
    Info 'depois: cd tv-app; .\gradlew.bat assembleRelease; adb install -r app\build\outputs\apk\release\app-release.apk'
}

# ---------------------------------------------------------- verificação --

Step '11. Verificação final'
if ((Test-Path $Tvg) -and (Test-Path $Config) -and -not $Check) {
    & $Tvg doctor
    if (Confirm 'Publicar os jogos no Sunshine agora (tvgames sync)?') {
        & $Tvg sync
        if ($LASTEXITCODE -eq 0) { Ok 'jogos publicados' }
    }
}

Write-Host ''
Write-Host '== Resumo ==' -ForegroundColor White
$pcShow = if ($PcIp) { $PcIp } else { '?' }
$tvShow = if ($TvIp) { $TvIp } else { 'não definida' }
$dispShow = if ($DispOut) { "$DispOut em $DispMode" } else { 'a tela atual (o tvgames não mexe)' }
Write-Host "  PC:            $pcShow  (a TV acessa a API em http://${pcShow}:$ApiPort)"
Write-Host "  TV:            $tvShow"
Write-Host "  Tela do jogo:  $dispShow"
Write-Host "  Config:        $Config"
Write-Host ''
Write-Host '  Onde colocar os jogos:'
Write-Host "    Super Nintendo   $RomSnes   (.sfc .smc .zip ...)"
Write-Host "    Nintendo 64      $RomN64   (.z64 .n64 .zip ...)"
Write-Host "    PS1 e PS2        $RomPs   (.iso .chd .bin/.cue ...; o console é detectado sozinho)"
Write-Host "    Capas próprias   $Covers   (opcional: <nome-da-rom>.png)"
Write-Host '    Jogos de PC      instale pela Steam, Heroic ou Hydra; aparecem sozinhos.'
Write-Host ''
Write-Host '  Depois de colocar ou instalar jogos novos: tvgames sync'
if ($script:Fails -gt 0) {
    Write-Host ''
    Write-Host "$($script:Fails) item(ns) faltando e $($script:Warns) aviso(s). Resolva os itens [falta] acima e rode o setup.ps1 de novo." -ForegroundColor Red
    exit 1
}
Write-Host ''
$extra = if ($script:Warns -gt 0) { " ($($script:Warns) aviso(s) acima, nenhum impede o uso)" } else { '' }
Write-Host "Pronto para jogar! Abra o app TVGames na TV e escolha um jogo.$extra" -ForegroundColor Green
