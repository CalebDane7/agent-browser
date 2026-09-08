[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [Parameter(Mandatory = $true)]
  [string]$HostExecutablePath,

  [Parameter(Mandatory = $true)]
  [string]$WslDistro,

  [Parameter(Mandatory = $true)]
  [string]$WslBridgePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($ExtensionId -cnotmatch '^[a-p]{32}$') {
  throw 'ExtensionId must be exactly 32 lowercase Chrome extension-ID characters (a-p).'
}
if ($WslDistro.Length -lt 1 -or $WslDistro.Length -gt 128 -or
    $WslDistro -cnotmatch '^[A-Za-z0-9._-]+(?: [A-Za-z0-9._-]+)*$') {
  throw 'WslDistro is not canonical.'
}
if ($WslBridgePath.Length -lt 2 -or $WslBridgePath.Length -gt 1024 -or
    -not $WslBridgePath.StartsWith('/') -or $WslBridgePath.EndsWith('/') -or
    $WslBridgePath -match '[\x00-\x1f\x7f\\]' -or
    $WslBridgePath -match '//' -or $WslBridgePath -match '/\.\.?(/|$)') {
  throw 'WslBridgePath must be a canonical absolute Linux path.'
}

$hostName = 'com.kaleeb.agent_browser'
$registryKey =
  "Registry::HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrWhiteSpace($localAppData)) {
  throw 'LocalApplicationData is unavailable.'
}
$installDirectory = Join-Path $localAppData 'AgentBrowser\NativeHost'
$installedHost = Join-Path $installDirectory 'agent-browser-native-host.exe'
$manifestPath = Join-Path $installDirectory "$hostName.json"
$configPath = Join-Path $installDirectory 'agent-browser-native-host.config.json'
$receiptPath = Join-Path $installDirectory 'install-receipt.json'

if (Test-Path -LiteralPath $registryKey) {
  throw 'The per-user native host registration already exists; this installer never updates in place.'
}
if (Test-Path -LiteralPath $installDirectory) {
  throw 'The native host install directory already exists; this installer never overwrites it.'
}

$resolvedSource = (Resolve-Path -LiteralPath $HostExecutablePath -ErrorAction Stop).Path
if ([IO.Path]::GetExtension($resolvedSource) -cne '.exe') {
  throw 'HostExecutablePath must identify a Windows .exe file.'
}
$wslExe = Join-Path $env:SystemRoot 'System32\wsl.exe'
if (-not (Test-Path -LiteralPath $wslExe -PathType Leaf)) {
  throw 'The fixed Windows WSL launcher is unavailable.'
}
& $wslExe '--distribution' $WslDistro '--exec' '/usr/bin/test' '-x' $WslBridgePath *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'The exact WSL bridge path is not executable in the selected distribution.'
}

$directoryCreated = $false
$registryCreated = $false
try {
  [void](New-Item -ItemType Directory -Path $installDirectory)
  $directoryCreated = $true
  Copy-Item -LiteralPath $resolvedSource -Destination $installedHost

  $generator = Join-Path $PSScriptRoot 'generate-manifest.ps1'
  & $generator `
    -ExtensionId $ExtensionId `
    -HostExecutablePath $installedHost `
    -WslDistro $WslDistro `
    -WslBridgePath $WslBridgePath `
    -OutputDirectory $installDirectory | Out-Null

  $origin = "chrome-extension://$ExtensionId/"
  $receipt = [ordered]@{
    schema = 'agent-browser.native-host-install.v1'
    host_name = $hostName
    allowed_origin = $origin
    files = [ordered]@{
      'agent-browser-native-host.exe' =
        (Get-FileHash -LiteralPath $installedHost -Algorithm SHA256).Hash.ToLowerInvariant()
      "$hostName.json" =
        (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
      'agent-browser-native-host.config.json' =
        (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText(
    $receiptPath,
    (($receipt | ConvertTo-Json -Compress -Depth 5) + "`n"),
    $utf8NoBom
  )

  [void](New-Item -Path $registryKey)
  $registryCreated = $true
  Set-Item -LiteralPath $registryKey -Value $manifestPath
} catch {
  if ($registryCreated -and (Test-Path -LiteralPath $registryKey)) {
    Remove-Item -LiteralPath $registryKey -Force
  }
  if ($directoryCreated -and (Test-Path -LiteralPath $installDirectory)) {
    Remove-Item -LiteralPath $installDirectory -Recurse -Force
  }
  throw
}

[pscustomobject]@{
  HostName = $hostName
  AllowedOrigin = "chrome-extension://$ExtensionId/"
  ManifestPath = $manifestPath
  RegistryHive = 'HKEY_CURRENT_USER'
}
