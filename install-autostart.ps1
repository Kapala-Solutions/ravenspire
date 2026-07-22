# install-autostart.ps1 — make AgentQuest start automatically when Windows logs in.
# Creates a shortcut in the current user's Startup folder that runs the hidden
# launcher (start-aihq.vbs). Re-running is safe (it just overwrites).
#
# Usage:   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# Remove:  powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'start-aihq.vbs'
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'AgentQuest.lnk'
$legacy = Join-Path $startup 'AI HQ.lnk'

if (-not (Test-Path $vbs)) { Write-Error "Launcher not found: $vbs"; exit 1 }

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = '"' + $vbs + '"'
$sc.WorkingDirectory = $here
$sc.WindowStyle = 7           # minimized (wscript itself shows nothing anyway)
$sc.Description = 'AgentQuest — mission control for your AI agents'
$sc.Save()

# migrate installs that predate the AgentQuest rename
if (Test-Path $legacy) { Remove-Item $legacy -Force }

Write-Output "Installed autostart shortcut: $lnk"
Write-Output "AgentQuest will launch hidden on next login (port from config.json)."
