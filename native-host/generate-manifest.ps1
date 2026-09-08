[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [Parameter(Mandatory = $true)]
  [string]$HostExecutablePath,

  [Parameter(Mandatory = $true)]
  [string]$WslDistro,

  [Parameter(Mandatory = $true)]
  [string]$WslBridgePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$hostName = 'com.kaleeb.agent_browser'
$configName = 'agent-browser-native-host.config.json'
$manifestName = "$hostName.json"

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
if (-not [IO.Path]::IsPathRooted($HostExecutablePath)) {
  throw 'HostExecutablePath must be absolute.'
}
$resolvedHost = (Resolve-Path -LiteralPath $HostExecutablePath -ErrorAction Stop).Path
if ([IO.Path]::GetExtension($resolvedHost) -cne '.exe') {
  throw 'HostExecutablePath must identify a Windows .exe file.'
}

$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $resolvedOutput) {
  if (-not (Test-Path -LiteralPath $resolvedOutput -PathType Container)) {
    throw 'OutputDirectory exists but is not a directory.'
  }
} else {
  [void](New-Item -ItemType Directory -Path $resolvedOutput)
}

$manifestPath = Join-Path $resolvedOutput $manifestName
$configPath = Join-Path $resolvedOutput $configName
foreach ($target in @($manifestPath, $configPath)) {
  if (Test-Path -LiteralPath $target) {
    throw "Refusing to overwrite existing generated file: $target"
  }
}

$origin = "chrome-extension://$ExtensionId/"
$manifest = [ordered]@{
  name = $hostName
  description = 'Private Agent Browser extension bridge'
  path = $resolvedHost
  type = 'stdio'
  allowed_origins = @($origin)
}
$config = [ordered]@{
  schema = 'agent-browser.native-host-config.v1'
  allowed_origin = $origin
  wsl_distro = $WslDistro
  wsl_bridge_path = $WslBridgePath
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText(
  $manifestPath,
  (($manifest | ConvertTo-Json -Compress -Depth 4) + "`n"),
  $utf8NoBom
)
[IO.File]::WriteAllText(
  $configPath,
  (($config | ConvertTo-Json -Compress -Depth 4) + "`n"),
  $utf8NoBom
)

[pscustomobject]@{
  HostName = $hostName
  ManifestPath = $manifestPath
  ConfigPath = $configPath
  AllowedOrigin = $origin
}
