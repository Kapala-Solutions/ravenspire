# notify.ps1 — native Windows toast (no modules). Fired by server.js so "needs
# you" alerts reach you with no browser open.
#
# When a -SessionId is passed, the toast becomes CLICKABLE: clicking it launches
# the ravenspire: protocol (registered by register-notifications.ps1), which POSTs
# /focus and brings that agent's window to the front.
#
# Usage: notify.ps1 -Title "..." -Body "..." [-SessionId <id>] [-Server <url>] [-Logo <png>]
param(
    [string]$Title = 'Ravenspire',
    [string]$Body = '',
    [string]$SessionId = '',
    [string]$Server = 'http://127.0.0.1:3456',
    [string]$Logo = ''
)
function Esc([string]$t) { $t -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;' }
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    # Borrow the Windows PowerShell AUMID (it's an installed app, so toasts are allowed).
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

    # Click action: only wire it up when we know which session to focus.
    $toastAttrs = 'activationType="foreground"'
    if ($SessionId) {
        $launch = "ravenspire:focus?session=$([uri]::EscapeDataString($SessionId))&server=$([uri]::EscapeDataString($Server))"
        $launchXml = $launch -replace '&', '&amp;'   # valid inside an XML attribute
        $toastAttrs = "activationType=""protocol"" launch=""$launchXml"""
    }

    # Optional app logo (the raven icon) from a local file.
    $logoXml = ''
    if ($Logo -and (Test-Path $Logo)) {
        $logoUri = ([uri](Resolve-Path $Logo).Path).AbsoluteUri
        $logoXml = "<image placement=""appLogoOverride"" hint-crop=""circle"" src=""$logoUri""/>"
    }

    $xml = @"
<toast $toastAttrs>
  <visual>
    <binding template="ToastGeneric">
      $logoXml
      <text>$(Esc $Title)</text>
      <text>$(Esc $Body)</text>
    </binding>
  </visual>
</toast>
"@

    $doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
    $doc.LoadXml($xml)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    Write-Output 'shown'
} catch {
    Write-Output "error: $($_.Exception.Message)"
}
