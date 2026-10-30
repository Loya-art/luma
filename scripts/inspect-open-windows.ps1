$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AlbumWindowProbe {
 public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int length);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder text,int length);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 public struct Rect {public int Left,Top,Right,Bottom;}
}
"@
$albumWindows = [System.Collections.Generic.List[object]]::new()
$callback = [AlbumWindowProbe+EnumProc] {
 param($windowHandle, $unused)
 if ([AlbumWindowProbe]::IsWindowVisible($windowHandle)) {
  $title = [Text.StringBuilder]::new(512)
  $className = [Text.StringBuilder]::new(256)
  [void][AlbumWindowProbe]::GetWindowText($windowHandle, $title, 512)
  [void][AlbumWindowProbe]::GetClassName($windowHandle, $className, 256)
  [uint32]$windowProcessId = 0
  [void][AlbumWindowProbe]::GetWindowThreadProcessId($windowHandle, [ref]$windowProcessId)
  $rectangle = [AlbumWindowProbe+Rect]::new()
  [void][AlbumWindowProbe]::GetWindowRect($windowHandle, [ref]$rectangle)
  if ($rectangle.Right-$rectangle.Left -gt 500 -and $rectangle.Bottom-$rectangle.Top -gt 300) {
   $albumWindows.Add([pscustomobject]@{Handle=$windowHandle.ToInt64();ProcessId=$windowProcessId;Title=$title.ToString();Class=$className.ToString();Left=$rectangle.Left;Top=$rectangle.Top;Width=$rectangle.Right-$rectangle.Left;Height=$rectangle.Bottom-$rectangle.Top})
  }
 }
 return $true
}
[void][AlbumWindowProbe]::EnumWindows($callback, [IntPtr]::Zero)
foreach ($entry in $albumWindows) {
 $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.ProcessId)"
 $entry | Add-Member -NotePropertyName ProcessName -NotePropertyValue $owner.Name
 $entry | Add-Member -NotePropertyName Executable -NotePropertyValue $owner.ExecutablePath
}
$albumWindows | ConvertTo-Json -Depth 4
