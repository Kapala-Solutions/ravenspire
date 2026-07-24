# register-notifications.ps1 — make Ravenspire's toasts pop as banners AND be
# clickable (click a "needs you" toast -> focus that agent's window).
#
#   Install:  powershell -ExecutionPolicy Bypass -File register-notifications.ps1
#   Remove:   powershell -ExecutionPolicy Bypass -File register-notifications.ps1 -Uninstall
#
# It (1) registers the `ravenspire:` URL protocol -> focus-notify.vbs, and
# (2) makes sure the toast identity is allowed to show banners (not just land
# silently in the Action Center). Focus Assist / Do Not Disturb can still
# suppress banners — turn that off if toasts don't pop.
param([switch]$Uninstall)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'focus-notify.vbs'
$protoKey = 'HKCU:\Software\Classes\ravenspire'

if ($Uninstall) {
    if (Test-Path $protoKey) { Remove-Item $protoKey -Recurse -Force }
    Write-Output 'Removed ravenspire: protocol.'
    return
}

if (-not (Test-Path $vbs)) { Write-Error "focus-notify.vbs not found: $vbs"; exit 1 }

# 1) URL protocol: ravenspire:focus?session=... -> focus-notify.vbs "%1"
New-Item -Path $protoKey -Force | Out-Null
Set-ItemProperty -Path $protoKey -Name '(default)' -Value 'URL:Ravenspire Protocol'
Set-ItemProperty -Path $protoKey -Name 'URL Protocol' -Value ''
$cmdKey = Join-Path $protoKey 'shell\open\command'
New-Item -Path $cmdKey -Force | Out-Null
Set-ItemProperty -Path $cmdKey -Name '(default)' -Value ('wscript.exe "' + $vbs + '" "%1"')

# 2) Allow banners for the toast identity (Windows PowerShell AUMID).
$aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$setKey = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\$aumid"
New-Item -Path $setKey -Force | Out-Null
Set-ItemProperty -Path $setKey -Name 'Enabled' -Value 1 -Type DWord
Set-ItemProperty -Path $setKey -Name 'ShowBanner' -Value 1 -Type DWord
Set-ItemProperty -Path $setKey -Name 'ShowInActionCenter' -Value 1 -Type DWord

Write-Output "Registered ravenspire: -> $vbs"
Write-Output "Banners enabled for Ravenspire toasts."
Write-Output "If toasts still don't pop, turn OFF Focus Assist / Do Not Disturb (Settings > System > Notifications)."
