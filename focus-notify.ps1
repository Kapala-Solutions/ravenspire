# focus-notify.ps1 — handler for the ravenspire: URL protocol. A clicked toast
# activates "ravenspire:focus?session=<id>&server=<url>"; Windows hands the whole
# URI here and we POST /focus so the server brings that agent's window forward.
param([string]$Uri)
try {
    $query = ''
    if ($Uri -match '\?(.*)$') { $query = $Matches[1] }
    $session = ''
    $server = 'http://127.0.0.1:3456'
    foreach ($pair in ($query -split '&')) {
        $kv = $pair -split '=', 2
        if ($kv.Count -eq 2) {
            $val = [uri]::UnescapeDataString($kv[1])
            switch ($kv[0]) {
                'session' { $session = $val }
                'server'  { $server = $val }
            }
        }
    }
    if ($session) {
        $body = @{ sessionId = $session } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$server/focus" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 5 | Out-Null
    }
} catch {
    try { Add-Content -Path (Join-Path $PSScriptRoot 'focus-notify.log') -Value "$(Get-Date -Format o)  $Uri  ::  $($_.Exception.Message)" } catch {}
}
