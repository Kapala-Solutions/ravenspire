# notify.ps1 — show a native Windows toast notification (no modules required).
# Used by server.js so "needs you" alerts reach the user even with no browser open.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File notify.ps1 -Title "..." -Body "..."
param(
    [string]$Title = 'Ravenspire',
    [string]$Body = ''
)
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    # Borrow the Windows PowerShell AUMID so no app registration is needed.
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName('text')
    $null = $texts.Item(0).AppendChild($template.CreateTextNode($Title))
    $null = $texts.Item(1).AppendChild($template.CreateTextNode($Body))

    $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    Write-Output 'shown'
} catch {
    Write-Output "error: $($_.Exception.Message)"
}
