' start-aihq.vbs — launch the AI HQ server with no visible console window.
' Used by the Windows startup shortcut created by install-autostart.ps1.
Dim sh, fso, here
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
' 0 = hidden window, False = don't wait for it to exit
sh.Run "node """ & here & "\server.js""", 0, False
