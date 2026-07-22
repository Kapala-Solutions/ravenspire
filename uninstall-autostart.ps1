# uninstall-autostart.ps1 — stop Ravenspire from starting with Windows.
$startup = [Environment]::GetFolderPath('Startup')
$removed = $false
foreach ($name in @('Ravenspire.lnk', 'AgentQuest.lnk', 'AI HQ.lnk')) {
    $lnk = Join-Path $startup $name
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Output "Removed autostart shortcut: $lnk"; $removed = $true }
}
if (-not $removed) { Write-Output "No autostart shortcut found." }
