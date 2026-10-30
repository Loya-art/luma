param(
  [Parameter(Mandatory = $true)][int]$ApplicationProcessId,
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\docs\acceptance'),
  [string]$ReportPrefix = '',
  [switch]$CloseWhenDone
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
# Win32 mouse flags and window-state APIs are documented by Microsoft:
# https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-mouse_event
# https://learn.microsoft.com/windows/win32/winmsg/window-features
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ShiguangWindowCheck {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first,uint second,bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window,int attribute,out Rect rect,int size);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
}
'@
[ShiguangWindowCheck]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$application = Get-CimInstance Win32_Process -Filter "ProcessId=$ApplicationProcessId"
if (-not $application -or $application.Name -notin @('Luma.exe', 'Shiguang.exe', 'electron.exe') -or $application.CommandLine -match '--type=') { throw 'The supplied PID is not a main application window.' }
$process = Get-Process -Id $ApplicationProcessId
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'The application has no native main window.' }
$report = [ordered]@{ started = [DateTime]::UtcNow.ToString('o'); processId = $ApplicationProcessId; title = $process.MainWindowTitle; checks = @() }
$original = New-Object ShiguangWindowCheck+Rect
$pointer = New-Object ShiguangWindowCheck+Point
function Focus-NativeWindow {
  # The test launcher can be a background console. Briefly share input queues to activate
  # this verified test window, then detach before any pointer input or wait.
  $currentThread = [ShiguangWindowCheck]::GetCurrentThreadId()
  [uint32]$foregroundProcess = 0
  [uint32]$applicationWindowProcess = 0
  $foregroundThread = [ShiguangWindowCheck]::GetWindowThreadProcessId([ShiguangWindowCheck]::GetForegroundWindow(), [ref]$foregroundProcess)
  $applicationThread = [ShiguangWindowCheck]::GetWindowThreadProcessId($handle, [ref]$applicationWindowProcess)
  $attachedForeground = $false
  $attachedApplication = $false
  try {
    if ($foregroundThread -ne $currentThread) { $attachedForeground = [ShiguangWindowCheck]::AttachThreadInput($currentThread, $foregroundThread, $true) }
    if ($applicationThread -ne $currentThread -and $applicationThread -ne $foregroundThread) { $attachedApplication = [ShiguangWindowCheck]::AttachThreadInput($currentThread, $applicationThread, $true) }
    [ShiguangWindowCheck]::BringWindowToTop($handle) | Out-Null
    [ShiguangWindowCheck]::SetForegroundWindow($handle) | Out-Null
    [ShiguangWindowCheck]::SetFocus($handle) | Out-Null
  } finally {
    if ($attachedApplication) { [ShiguangWindowCheck]::AttachThreadInput($currentThread, $applicationThread, $false) | Out-Null }
    if ($attachedForeground) { [ShiguangWindowCheck]::AttachThreadInput($currentThread, $foregroundThread, $false) | Out-Null }
  }
}
[ShiguangWindowCheck]::GetCursorPos([ref]$pointer) | Out-Null
[ShiguangWindowCheck]::ShowWindow($handle, 9) | Out-Null
Focus-NativeWindow
Start-Sleep -Milliseconds 300
[ShiguangWindowCheck]::GetWindowRect($handle, [ref]$original) | Out-Null
function Get-VisibleRectangle {
  $rectangle = New-Object ShiguangWindowCheck+Rect
  if ([ShiguangWindowCheck]::DwmGetWindowAttribute($handle, 9, [ref]$rectangle, 16) -ne 0) { [ShiguangWindowCheck]::GetWindowRect($handle, [ref]$rectangle) | Out-Null }
  return $rectangle
}
function Click-NativeButton([int]$OffsetFromRight) {
  if ([ShiguangWindowCheck]::GetForegroundWindow() -ne $handle) { throw 'The application lost focus; native input was stopped.' }
  $rectangle = Get-VisibleRectangle
  $scale = [ShiguangWindowCheck]::GetDpiForWindow($handle) / 96.0
  $x = [int]($rectangle.Right - (46 * ($OffsetFromRight + .5) * $scale))
  $y = [int]($rectangle.Top + (18 * $scale))
  [ShiguangWindowCheck]::SetCursorPos($x, $y) | Out-Null
  [ShiguangWindowCheck]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [ShiguangWindowCheck]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
}
try {
  Click-NativeButton 2
  if (-not [ShiguangWindowCheck]::IsIconic($handle)) { throw 'Native minimize button did not minimize the window.' }
  $report.checks += 'native minimize button'
  [ShiguangWindowCheck]::ShowWindow($handle, 9) | Out-Null
  Focus-NativeWindow
  Start-Sleep -Milliseconds 300
  Click-NativeButton 1
  if (-not [ShiguangWindowCheck]::IsZoomed($handle)) { throw 'Native maximize button did not maximize the window.' }
  $report.checks += 'native maximize button'
  Click-NativeButton 1
  if ([ShiguangWindowCheck]::IsZoomed($handle)) { throw 'Native restore button did not restore the window.' }
  $report.checks += 'native restore button'
  $beforeDrag = Get-VisibleRectangle
  if ([ShiguangWindowCheck]::GetForegroundWindow() -ne $handle) { throw 'The application lost focus before dragging; native input was stopped.' }
  $scale = [ShiguangWindowCheck]::GetDpiForWindow($handle) / 96.0
  $dragX = [int]($beforeDrag.Left + (($beforeDrag.Right - $beforeDrag.Left) * .23))
  $dragY = [int]($beforeDrag.Top + (18 * $scale))
  [ShiguangWindowCheck]::SetCursorPos($dragX, $dragY) | Out-Null
  [ShiguangWindowCheck]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  try { for ($step = 1; $step -le 6; $step++) { [ShiguangWindowCheck]::SetCursorPos(($dragX + $step * 10),($dragY + $step * 7)) | Out-Null; Start-Sleep -Milliseconds 35 } }
  finally { [ShiguangWindowCheck]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 200
  $afterDrag = Get-VisibleRectangle
  $delta = [ordered]@{ x = $afterDrag.Left - $beforeDrag.Left; y = $afterDrag.Top - $beforeDrag.Top }
  if ([Math]::Abs($delta.x) -lt 20 -and [Math]::Abs($delta.y) -lt 20) { throw 'The transparent top strip did not drag the native window.' }
  $report.checks += 'transparent top strip drags native window'
  $report.dragDelta = $delta
  [ShiguangWindowCheck]::SetWindowPos($handle,[IntPtr]::Zero,$original.Left,$original.Top,($original.Right-$original.Left),($original.Bottom-$original.Top),20) | Out-Null
  Start-Sleep -Milliseconds 200
  $rectangle = Get-VisibleRectangle
  $bitmap = New-Object System.Drawing.Bitmap(($rectangle.Right-$rectangle.Left),($rectangle.Bottom-$rectangle.Top))
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  $screenshot = Join-Path ([System.IO.Path]::GetFullPath($OutputDirectory)) "${ReportPrefix}native-window.png"
  try { $graphics.CopyFromScreen($rectangle.Left,$rectangle.Top,0,0,$bitmap.Size); $bitmap.Save($screenshot,[System.Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
  $report.screenshot = $screenshot
  if ($CloseWhenDone) {
    Click-NativeButton 0
    if (-not $process.WaitForExit(15000)) { throw 'The native close button did not close the application normally.' }
    $report.checks += 'native close button exits normally'
  }
  $report.status = 'passed'
} catch { $report.status = 'failed'; $report.failure = $_.Exception.Message; throw }
finally {
  [ShiguangWindowCheck]::SetCursorPos($pointer.X, $pointer.Y) | Out-Null
  $report.finished = [DateTime]::UtcNow.ToString('o')
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  $reportJson = $report | ConvertTo-Json -Depth 6
  $reportJson | Set-Content -LiteralPath (Join-Path $OutputDirectory "${ReportPrefix}native-window-report.json") -Encoding utf8
  $reportJson
}
