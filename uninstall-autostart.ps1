# uninstall-autostart.ps1 — stop AI HQ from starting with Windows.
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'AI HQ.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Output "Removed autostart shortcut: $lnk" }
else { Write-Output "No autostart shortcut found." }
