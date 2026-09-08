[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($ExtensionId -cnotmatch '^[a-p]{32}$') {
  throw 'ExtensionId must be exactly 32 lowercase Chrome extension-ID characters (a-p).'
}

$hostName = 'com.kaleeb.agent_browser'
$expectedOrigin = "chrome-extension://$ExtensionId/"
$registryKey =
  "Registry::HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrWhiteSpace($localAppData)) {
  throw 'LocalApplicationData is unavailable.'
}
$installDirectory = Join-Path $localAppData 'AgentBrowser\NativeHost'
$hostPath = Join-Path $installDirectory 'agent-browser-native-host.exe'
$manifestPath = Join-Path $installDirectory "$hostName.json"
$configPath = Join-Path $installDirectory 'agent-browser-native-host.config.json'
$receiptPath = Join-Path $installDirectory 'install-receipt.json'

$hasRegistration = Test-Path -LiteralPath $registryKey
$hasDirectory = Test-Path -LiteralPath $installDirectory
if (-not $hasRegistration -and -not $hasDirectory) {
  [pscustomobject]@{ HostName = $hostName; Removed = $false }
  return
}
if (-not $hasRegistration -or -not $hasDirectory) {
  throw 'Registration and install directory disagree; refusing an unverified partial removal.'
}
foreach ($required in @($hostPath, $manifestPath, $configPath, $receiptPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required install receipt is missing: $required"
  }
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if ($manifest.name -cne $hostName -or $manifest.path -cne $hostPath -or
    $manifest.type -cne 'stdio' -or $manifest.allowed_origins.Count -ne 1 -or
    $manifest.allowed_origins[0] -cne $expectedOrigin -or
    $config.schema -cne 'agent-browser.native-host-config.v1' -or
    $config.allowed_origin -cne $expectedOrigin -or
    $receipt.schema -cne 'agent-browser.native-host-install.v1' -or
    $receipt.host_name -cne $hostName -or
    $receipt.allowed_origin -cne $expectedOrigin) {
  throw 'Installed files do not match the explicitly requested extension identity.'
}

$registeredManifest = (Get-Item -LiteralPath $registryKey).GetValue('')
if ($registeredManifest -cne $manifestPath) {
  throw 'The per-user registration points at an unexpected manifest.'
}

$expectedHashes = @{
  'agent-browser-native-host.exe' = $receipt.files.'agent-browser-native-host.exe'
  "$hostName.json" = $receipt.files."$hostName.json"
  'agent-browser-native-host.config.json' =
    $receipt.files.'agent-browser-native-host.config.json'
}
$actualPaths = @{
  'agent-browser-native-host.exe' = $hostPath
  "$hostName.json" = $manifestPath
  'agent-browser-native-host.config.json' = $configPath
}
$changedFiles = @()
foreach ($name in $actualPaths.Keys) {
  $actual = (Get-FileHash -LiteralPath $actualPaths[$name] -Algorithm SHA256).Hash
  if ($actual -cne ([string]$expectedHashes[$name]).ToUpperInvariant()) {
    $changedFiles += $name
  }
}

# Disable Chrome discovery first after all identity/path checks succeed. If local
# bytes changed since installation, leave those bytes intact for inspection.
Remove-Item -LiteralPath $registryKey -Force
if ($changedFiles.Count -ne 0) {
  throw "Registration removed, but changed installed files were preserved: $($changedFiles -join ', ')"
}

# The installer owns only these four exact files. Never recursively remove their
# parent: a later unrelated file or subdirectory must survive uninstall.
foreach ($ownedPath in @($hostPath, $manifestPath, $configPath, $receiptPath)) {
  Remove-Item -LiteralPath $ownedPath -Force
}

$installDirectoryRemoved = $false
$preservedEntryCount = 0
try {
  Remove-Item -LiteralPath $installDirectory -Force -ErrorAction Stop
  $installDirectoryRemoved = $true
} catch {
  if (-not (Test-Path -LiteralPath $installDirectory -PathType Container)) {
    throw
  }
  $preservedEntryCount = @(
    Get-ChildItem -LiteralPath $installDirectory -Force -ErrorAction Stop
  ).Count
  if ($preservedEntryCount -eq 0) {
    throw
  }
}

[pscustomobject]@{
  HostName = $hostName
  Removed = $true
  RegistryHive = 'HKEY_CURRENT_USER'
  InstallDirectoryRemoved = $installDirectoryRemoved
  PreservedEntryCount = $preservedEntryCount
}
