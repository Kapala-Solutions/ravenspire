# send-event.ps1 — forward a Claude Code OR OpenAI Codex hook payload to the
# Ravenspire server.
#
# Both CLIs pipe the hook event as JSON on stdin using the same field names
# (session_id, cwd, transcript_path, tool_name, tool_input, prompt,
# last_assistant_message). This script reads that JSON, augments it with IDE
# detection, the event type, and the source CLI, then POSTs it to the server.
#
# Usage (Claude): send-event.ps1 -Type SessionStart -Server 'http://127.0.0.1:3456'
# Usage (Codex):  send-event.ps1 -Type PreToolUse -Source codex -Server 'http://127.0.0.1:3456'
param(
    [string]$Type,
    [string]$Server = "",
    [string]$Source = "code"
)

# Resolve server URL: param > env var > default
if (-not $Server) { $Server = $env:AI_HQ_SERVER }
if (-not $Server) { $Server = "http://127.0.0.1:3456" }

# Read the hook payload from stdin (may be empty for some invocations)
$payload = $null
try {
    $raw = [Console]::In.ReadToEnd()
    if ($raw) { $payload = $raw | ConvertFrom-Json }
} catch {
    $payload = $null
}

# Pull real values from the payload with safe fallbacks
$sessionId      = if ($payload.session_id) { $payload.session_id } else { "unknown" }
$cwd            = if ($payload.cwd) { $payload.cwd } else { (Get-Location).Path }
$transcriptPath = if ($payload.transcript_path) { $payload.transcript_path } else { "" }
$toolName       = if ($payload.tool_name) { $payload.tool_name } else { "" }
$hookEvent      = if ($payload.hook_event_name) { $payload.hook_event_name } else { $Type }
$message        = if ($payload.message) { [string]$payload.message } else { "" }

# Codex feeds these directly on the hook payload (Claude derives them from the
# transcript instead). Harmless to capture for both; the server picks the right
# source. prompt = UserPromptSubmit text; last_assistant_message = Stop text.
$prompt  = if ($payload.prompt) { [string]$payload.prompt } else { "" }
$prompt  = (($prompt -replace "[\r\n\t]+", " ") -replace "\s{2,}", " ").Trim()
if ($prompt.Length -gt 300) { $prompt = $prompt.Substring(0, 300) }
$lastMsg = if ($payload.last_assistant_message) { [string]$payload.last_assistant_message } else { "" }
if ($lastMsg.Length -gt 1500) { $lastMsg = $lastMsg.Substring(0, 1500) }
$model   = if ($payload.model) { [string]$payload.model } else { "" }

# Build a short human-readable "target" from tool_input (varies per tool)
$target = ""
$ti = $payload.tool_input
if ($ti) {
    if ($ti.file_path)      { $target = Split-Path ([string]$ti.file_path) -Leaf }
    elseif ($ti.path)       { $target = Split-Path ([string]$ti.path) -Leaf }
    elseif ($ti.notebook_path) { $target = Split-Path ([string]$ti.notebook_path) -Leaf }
    elseif ($ti.command)    { $c = [string]$ti.command; $target = $c.Substring(0, [Math]::Min(50, $c.Length)) }
    elseif ($ti.pattern)    { $target = [string]$ti.pattern }
    elseif ($ti.query)      { $target = [string]$ti.query }
    elseif ($ti.url)        { $target = [string]$ti.url }
    elseif ($ti.description){ $target = [string]$ti.description }
}
# Collapse newlines/whitespace so multi-line commands render on one line
$target = ($target -replace "[\r\n\t]+", " ") -replace "\s{2,}", " "
$target = $target.Trim()

# Detect which Claude surface this is running under
$entrypoint = $env:CLAUDE_CODE_ENTRYPOINT
$termProgram = $env:TERM_PROGRAM
$ide = "cli"
if ($entrypoint) {
    $ide = $entrypoint
} elseif ($termProgram -eq "vscode") {
    $ide = "vscode"
}
# Normalize common values
switch -Wildcard ($ide) {
    "*vscode*"  { $ide = "vscode" }
    "*cli*"     { $ide = "cli" }
    "*sdk*"     { $ide = "sdk" }
}

$title = Split-Path $cwd -Leaf

# Capture the owning window (terminal / IDE / app) so the dashboard can focus it.
# Walk up the process tree to the first ancestor that owns a REAL window, skipping
# the desktop shell and system hosts (so we never "focus the desktop"). For classic
# consoles (cmd/pwsh with no window of their own) fall back to their conhost child.
# Done on the low-frequency lifecycle events so the window stays fresh for clicks.
$windowPid = 0
$windowName = ""
$windowTitle = ""
$windowChain = ""
if ($Type -in @('SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest')) {
    try {
        $exclude = @('explorer','dwm','svchost','services','wininit','winlogon','csrss',
            'sihost','fontdrvhost','runtimebroker','textinputhost','searchhost',
            'startmenuexperiencehost','shellexperiencehost','applicationframehost','searchapp')
        $chain = @()
        $cur = $PID
        for ($i = 0; $i -lt 14; $i++) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
            if (-not $proc) { break }
            $gp = Get-Process -Id $cur -ErrorAction SilentlyContinue
            $h = if ($gp) { [int64]$gp.MainWindowHandle } else { 0 }
            $nm = ($proc.Name -replace '\.exe$', '').ToLower()
            $chain += $nm
            if ($h -ne 0 -and ($exclude -notcontains $nm)) {
                $windowPid = $cur; $windowName = $nm; $windowTitle = $gp.MainWindowTitle; break
            }
            $ppid = [int]$proc.ParentProcessId
            if ($ppid -le 0) { break }
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$ppid" -ErrorAction SilentlyContinue
            $pnm = if ($parent) { ($parent.Name -replace '\.exe$', '').ToLower() } else { '' }
            if ($exclude -contains $pnm) {
                # overshoot: parent is the desktop/system. Try a conhost child of this console app.
                $ch = Get-CimInstance Win32_Process -Filter "ParentProcessId=$cur AND Name='conhost.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($ch) {
                    $cg = Get-Process -Id $ch.ProcessId -ErrorAction SilentlyContinue
                    if ($cg -and $cg.MainWindowHandle -ne 0) {
                        $windowPid = [int]$ch.ProcessId; $windowName = 'conhost'; $windowTitle = $cg.MainWindowTitle
                    }
                }
                break
            }
            $cur = $ppid
        }
        $windowChain = ($chain -join '>')

        # Fallback: Windows Terminal as the default terminal breaks the tree walk
        # (the console's window belongs to WindowsTerminal.exe, which is NOT an
        # ancestor — the shell's parent is explorer). But on UserPromptSubmit the
        # user literally just pressed Enter in this session's window, so the
        # foreground window IS the right one. Capture it.
        if ($windowPid -eq 0 -and $Type -eq 'UserPromptSubmit') {
            Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AqFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@ -ErrorAction SilentlyContinue
            $fgPid = [uint32]0
            [AqFg]::GetWindowThreadProcessId([AqFg]::GetForegroundWindow(), [ref]$fgPid) | Out-Null
            if ($fgPid -gt 0) {
                $fp = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
                $fnm = if ($fp) { $fp.ProcessName.ToLower() } else { '' }
                if ($fp -and $fp.MainWindowHandle -ne 0 -and ($exclude -notcontains $fnm)) {
                    $windowPid = [int]$fgPid
                    $windowName = $fnm
                    $windowTitle = $fp.MainWindowTitle
                    $windowChain = $windowChain + '>fg:' + $fnm
                }
            }
        }
    } catch {}
}

$body = @{
    type           = $Type
    hookEvent      = $hookEvent
    source         = "$Source"
    tool           = $toolName
    target         = "$target"
    message        = "$message"
    prompt         = "$prompt"
    lastMessage    = "$lastMsg"
    model          = "$model"
    sessionId      = "$sessionId"
    cwd            = "$cwd"
    transcriptPath = "$transcriptPath"
    ide            = "$ide"
    title          = $title
    windowPid      = $windowPid
    windowName     = "$windowName"
    windowTitle    = "$windowTitle"
    windowChain    = "$windowChain"
    host           = $env:COMPUTERNAME
    timestamp      = (Get-Date -Format "o")
} | ConvertTo-Json -Compress

try {
    Invoke-RestMethod -Uri "$Server/event" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 2 | Out-Null
} catch {
    # Silently ignore if the server is down
}
