' Hidden launcher for the model-alias proxy (used by the Startup shortcut).
' Location-independent: runs proxy.js next to this file. Node comes from
' .local.env (NODE_PATH, written by setup.js) or falls back to PATH.
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
HERE = fso.GetParentFolderName(WScript.ScriptFullName)

Function LocalValue(key)
  LocalValue = ""
  If Not fso.FileExists(HERE & "\.local.env") Then Exit Function
  Set f = fso.OpenTextFile(HERE & "\.local.env", 1)
  Do Until f.AtEndOfStream
    line = Trim(f.ReadLine())
    If Left(line, Len(key) + 1) = key & "=" Then LocalValue = Mid(line, Len(key) + 2)
  Loop
  f.Close
End Function

node = LocalValue("NODE_PATH")
If node = "" Or Not fso.FileExists(node) Then node = "node"
sh.CurrentDirectory = HERE
sh.Run """" & node & """ """ & HERE & "\proxy.js""", 0, False
