' Claude Desktop launcher — lifecycle-coupled with the model-alias proxy.
'  - starts the proxy ONLY if it is not already listening (the launcher owns
'    what it starts)
'  - opens Claude Desktop
'  - once every claude.exe has exited, stops the proxy it started
'    (config.json "exit_with_client": "always" also stops a pre-existing proxy)
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
HERE = fso.GetParentFolderName(WScript.ScriptFullName)

started = False
rc = sh.Run("cmd /c netstat -an | findstr /c:""127.0.0.1:8787"" >nul", 0, True)
If rc <> 0 Then
  sh.Run """C:\Program Files\nodejs\node.exe"" """ & HERE & "\proxy.js""", 0, False
  started = True
  WScript.Sleep 1200
End If

sh.Run "explorer.exe shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude", 0, False

exitMode = "owned"
On Error Resume Next
cfg = fso.OpenTextFile(HERE & "\config.json", 1).ReadAll
Err.Clear
On Error GoTo 0
If InStr(cfg, """exit_with_client"": ""always""") > 0 Then exitMode = "always"

If started Or exitMode = "always" Then
  Do
    WScript.Sleep 5000
    rc = sh.Run("cmd /c tasklist | findstr /i ""claude.exe"" >nul", 0, True)
  Loop While rc = 0
  WScript.Sleep 2000
  rc2 = sh.Run("cmd /c tasklist | findstr /i ""claude.exe"" >nul", 0, True)
  If rc2 <> 0 Then
    If fso.FileExists(HERE & "\proxy.pid") Then
      pid = Trim(fso.OpenTextFile(HERE & "\proxy.pid", 1).ReadAll)
      sh.Run "cmd /c taskkill /f /pid " & pid & " >nul 2>&1", 0, True
      fso.DeleteFile HERE & "\proxy.pid", True
    End If
  End If
End If
