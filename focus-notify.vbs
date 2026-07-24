' focus-notify.vbs — invoked by the ravenspire: URL protocol. Runs the focus
' handler hidden (no console flash) and forwards the full activation URI (%1).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
arg = ""
If WScript.Arguments.Count > 0 Then arg = WScript.Arguments(0)
sh.Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & here & "\focus-notify.ps1"" """ & arg & """", 0, False
