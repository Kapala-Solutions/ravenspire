# register-notifications.ps1 — make sure Ravenspire's "needs you" toasts pop as
# banners (not just land silently in the Action Center).
#
#   npm run setup:notify
#   powershell -ExecutionPolicy Bypass -File register-notifications.ps1
#
# Clicking a toast is handled by an http URL (server /focus-click), so no custom
# URL protocol is needed. This just flips the per-identity banner setting on and
# cleans up the obsolete `ravenspire:` protocol key from earlier builds.
#
# NOTE: Focus Assist / Do Not Disturb can still suppress banners — turn it off in
# Settings > System > Notifications if toasts don't pop.
param([switch]$Uninstall)

$staleProto = 'HKCU:\Software\Classes\ravenspire'
if (Test-Path $staleProto) { Remove-Item $staleProto -Recurse -Force; Write-Output 'Removed obsolete ravenspire: protocol.' }

# Allow banners for the toast identity (borrowed Windows PowerShell AUMID).
$aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$setKey = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\$aumid"

if ($Uninstall) {
    if (Test-Path $setKey) { Remove-Item $setKey -Recurse -Force }
    Write-Output 'Reset Ravenspire toast banner settings.'
    return
}

New-Item -Path $setKey -Force | Out-Null
Set-ItemProperty -Path $setKey -Name 'Enabled' -Value 1 -Type DWord
Set-ItemProperty -Path $setKey -Name 'ShowBanner' -Value 1 -Type DWord
Set-ItemProperty -Path $setKey -Name 'ShowInActionCenter' -Value 1 -Type DWord

Write-Output 'Banners enabled for Ravenspire toasts.'
Write-Output "If toasts still don't pop, turn OFF Focus Assist / Do Not Disturb (Settings > System > Notifications)."
