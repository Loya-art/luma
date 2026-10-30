param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\Shiguang'),
  [switch]$Upgrade,
  [switch]$ValidateOnly,
  [int]$ApplicationProcessId = 0
)
$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $projectDirectory 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$installerPath = Join-Path $projectDirectory "release\Luma-$($package.version)-Setup.exe"
$targetDirectory = [System.IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$executablePath = Join-Path $targetDirectory "$($package.build.win.executableName).exe"
# Display branding may change; the durable library/key/job location must not.
$userDataDirectory = Join-Path $env:APPDATA '拾光'
if (-not $ValidateOnly -and -not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw "Installer missing: $installerPath" }
if ($targetDirectory -eq [System.IO.Path]::GetPathRoot($targetDirectory).TrimEnd('\')) { throw 'The installation directory cannot be a drive root.' }
$previousVersion = $null
$previousExecutablePath = $null
$backupReceipt = $null
if (Test-Path -LiteralPath $targetDirectory) {
  if (-not $Upgrade) { throw 'The target exists. Use -Upgrade after identifying the installed application.' }
  $candidateExecutables = @(@('Luma.exe', 'Shiguang.exe') | ForEach-Object { Join-Path $targetDirectory $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  if ($candidateExecutables.Count -ne 1) { throw 'Existing target must contain exactly one known Luma or legacy Shiguang application executable.' }
  $previousExecutablePath = $candidateExecutables[0]
  $program = Get-Item -LiteralPath $previousExecutablePath
  if ($program.VersionInfo.ProductName -notin @('拾光', 'Luma')) { throw 'Existing executable product identity does not match.' }
  $identityOutput = & node (Join-Path $PSScriptRoot 'install-state.mjs') identity $targetDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Existing application archive identity check failed.' }
  $identity = $identityOutput | ConvertFrom-Json
  $registration = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($identity.guid)"
  if ($registration.UninstallString -notmatch '^"([^"]+)"') { throw 'The registered uninstaller path could not be verified.' }
  $registeredUninstaller = [System.IO.Path]::GetFullPath($Matches[1])
  $uninstallerDirectory = [System.IO.Path]::GetDirectoryName($registeredUninstaller)
  $uninstallerName = [System.IO.Path]::GetFileName($registeredUninstaller)
  if (-not $uninstallerDirectory.Equals($targetDirectory, [StringComparison]::OrdinalIgnoreCase) -or $uninstallerName -notin @('Uninstall Shiguang.exe', 'Uninstall Luma.exe')) { throw 'The appId registration belongs to another installation directory or product.' }
  $previousVersion = $identity.version
  $runningMain = @(Get-CimInstance Win32_Process -Filter "Name='Shiguang.exe' OR Name='Luma.exe'" | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.Equals($previousExecutablePath, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '--type='
  })
  if ($ValidateOnly) {
    [ordered]@{ validationOnly = $true; appId = $identity.appId; guid = $identity.guid; previousVersion = $previousVersion; previousExecutable = $previousExecutablePath; registeredUninstaller = $registeredUninstaller; newExecutable = $executablePath; userDataDirectory = $userDataDirectory; runningMainPids = @($runningMain | ForEach-Object { $_.ProcessId }) } | ConvertTo-Json -Depth 4
    return
  }
  foreach ($application in $runningMain) {
    if ($ApplicationProcessId -ne $application.ProcessId) { throw "Application process $($application.ProcessId) is still running. Supply its verified production PID through -ApplicationProcessId; isolated test processes must be closed by their owner." }
    $process = Get-Process -Id $ApplicationProcessId
    if (-not $process.CloseMainWindow()) { throw 'The application could not be closed through its main window.' }
    if (-not $process.WaitForExit(15000)) { throw 'The application is still saving. No forced termination was performed.' }
  }
}
if ($ValidateOnly) { [ordered]@{ validationOnly = $true; existingInstallation = $false; newExecutable = $executablePath; userDataDirectory = $userDataDirectory } | ConvertTo-Json; return }
$backupOutput = & node (Join-Path $PSScriptRoot 'install-state.mjs') backup $userDataDirectory
if ($LASTEXITCODE -ne 0) { throw 'Library backup failed; the existing installation was not changed.' }
$backupReceipt = $backupOutput | ConvertFrom-Json

# NSIS requires /D to be the final argument and consumes the remainder as the directory.
$installerProcess = Start-Process -FilePath $installerPath -ArgumentList "/S /currentuser /D=$targetDirectory" -WindowStyle Hidden -PassThru -Wait
if ($installerProcess.ExitCode -ne 0) { throw "Installer exited with code $($installerProcess.ExitCode)" }
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) { throw 'Installer completed without the expected application executable.' }
$program = Get-Item -LiteralPath $executablePath
if ($program.VersionInfo.ProductName -ne 'Luma') { throw 'The installed executable must display the Luma product name.' }
$installedVersion = [Version]$program.VersionInfo.ProductVersion
if ("$($installedVersion.Major).$($installedVersion.Minor).$($installedVersion.Build)" -ne $package.version) { throw 'The installed executable version does not match the requested update.' }
$shortcuts = @()
$removedLegacyShortcuts = @()
$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutDirectory in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  $shortcutPath = Join-Path $shortcutDirectory "$($package.build.nsis.shortcutName).lnk"
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw "Expected shortcut missing: $shortcutPath" }
  $shortcut = $shell.CreateShortcut($shortcutPath)
  if (-not $shortcut.TargetPath.Equals($executablePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The installed shortcut points to another executable.' }
  $shortcuts += [ordered]@{ path = $shortcutPath; target = $shortcut.TargetPath; icon = $shortcut.IconLocation }
  # NSIS normally renames these from its stored ShortcutName. If an old link
  # remains, remove only the exact known legacy name targeting this verified app.
  if ($previousExecutablePath) {
    foreach ($legacyName in @('拾光相册', '时光相册')) {
      $legacyLink = Join-Path $shortcutDirectory "$legacyName.lnk"
      if (Test-Path -LiteralPath $legacyLink -PathType Leaf) {
        $legacyShortcut = $shell.CreateShortcut($legacyLink)
        if ($legacyShortcut.TargetPath.Equals($previousExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
          Remove-Item -LiteralPath $legacyLink
          $removedLegacyShortcuts += $legacyLink
        }
      }
    }
  }
}
$receipt = [ordered]@{
  installedAt = [DateTime]::UtcNow.ToString('o')
  installer = $installerPath
  installerExitCode = $installerProcess.ExitCode
  installerBytes = (Get-Item -LiteralPath $installerPath).Length
  executable = $executablePath
  productName = $program.VersionInfo.ProductName
  productVersion = $program.VersionInfo.ProductVersion
  previousVersion = $previousVersion
  userDataBackup = $backupReceipt
  ffmpegBundled = Test-Path -LiteralPath (Join-Path $targetDirectory 'resources\binaries\ffmpeg.exe')
  ffprobeBundled = Test-Path -LiteralPath (Join-Path $targetDirectory 'resources\binaries\ffprobe.exe')
  shortcuts = $shortcuts
  removedLegacyShortcuts = $removedLegacyShortcuts
  userDataDirectory = $userDataDirectory
}
if (-not $receipt.ffmpegBundled -or -not $receipt.ffprobeBundled) { throw 'The installed media runtime is incomplete.' }
$acceptanceDirectory = Join-Path $projectDirectory 'docs\acceptance'
New-Item -ItemType Directory -Path $acceptanceDirectory -Force | Out-Null
$receiptJson = $receipt | ConvertTo-Json -Depth 8
$receiptJson | Set-Content -LiteralPath (Join-Path $acceptanceDirectory "installation-$($package.version).json") -Encoding utf8
$receiptJson | Set-Content -LiteralPath (Join-Path $acceptanceDirectory 'installation.json') -Encoding utf8
$receiptJson
