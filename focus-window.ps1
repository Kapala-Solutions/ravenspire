# focus-window.ps1 — bring a process's main window to the foreground by PID.
param([int]$WindowPid)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AiHqWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

$p = Get-Process -Id $WindowPid -ErrorAction SilentlyContinue
if (-not $p -or $p.MainWindowHandle -eq 0) { Write-Output "no-window"; exit 1 }

# Never focus the desktop shell or a system host (defense against a bad capture)
$blocked = @('explorer','dwm','svchost','services','wininit','winlogon','csrss','sihost','fontdrvhost')
if ($blocked -contains $p.ProcessName.ToLower()) { Write-Output "blocked-$($p.ProcessName)"; exit 1 }

$h = $p.MainWindowHandle
# Restore if minimized (SW_RESTORE = 9)
if ([AiHqWin]::IsIconic($h)) { [AiHqWin]::ShowWindow($h, 9) | Out-Null }

# The Alt keypress satisfies Windows' foreground-lock rules so the window
# actually comes forward instead of just flashing in the taskbar.
[AiHqWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)          # Alt down
[AiHqWin]::SetForegroundWindow($h) | Out-Null
[AiHqWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)          # Alt up
Write-Output "focused"
