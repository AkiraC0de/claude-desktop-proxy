' Claude Desktop launcher — lifecycle-coupled with the model-alias proxy.
'  - starts the proxy ONLY if it is not already listening (the launcher owns
'    what it starts)
'  - opens Claude Desktop
'  - once Claude Desktop has exited, stops the proxy it started
'    (config.json "exit_with_client": "always" also stops a pre-existing proxy)
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set wmi = CreateObject("WbemScripting.SWbemLocator").ConnectServer(".", "root\cimv2")
HERE = fso.GetParentFolderName(WScript.ScriptFullName)

' Machine-specific values written by setup.js (.local.env). Nothing in this
' file is tied to the project's location.
Function LocalValue(key)
  LocalValue = ""
  If Not fso.FileExists(HERE & ".local.env") Then Exit Function
  Set f = fso.OpenTextFile(HERE & ".local.env", 1)
  Do Until f.AtEndOfStream
    line = Trim(f.ReadLine())
    If Left(line, Len(key) + 1) = key & "=" Then LocalValue = Mid(line, Len(key) + 2)
  Loop
  f.Close
End Function

node = LocalValue("NODE_PATH")
If node = "" Or Not fso.FileExists(node) Then node = "node"
appId = LocalValue("DESKTOP_APP_ID")
If appId = "" Then appId = "Claude_pzs8sxrjxfjjc!Claude"
sh.CurrentDirectory = HERE

Function ConfigMatch(pattern)
  ConfigMatch = ""
  If Not fso.FileExists(HERE & "\config.json") Then Exit Function
  Set f = fso.OpenTextFile(HERE & "\config.json", 1)
  text = f.ReadAll
  f.Close
  Set re = New RegExp
  re.Pattern = pattern
  re.IgnoreCase = True
  Set m = re.Execute(text)
  If m.Count > 0 Then ConfigMatch = m(0).SubMatches(0)
End Function

' True while a Claude Desktop (MSIX install) process exists. Claude Code CLI's
' claude.exe lives elsewhere and is ignored.
Function DesktopRunning()
  DesktopRunning = False
  Set procs = wmi.ExecQuery("SELECT ExecutablePath FROM Win32_Process WHERE Name='claude.exe'")
  For Each p In procs
    If Not IsNull(p.ExecutablePath) Then
      If InStr(1, p.ExecutablePath, "\WindowsApps\Claude_", vbTextCompare) > 0 Then
        DesktopRunning = True
        Exit Function
      End If
    End If
  Next
End Function

' Kill pid only if it is still a node.exe running proxy.js (guards stale pid files).
Sub KillProxy(pid)
  Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" & pid & " AND Name='node.exe'")
  For Each p In procs
    If Not IsNull(p.CommandLine) Then
      If InStr(1, p.CommandLine, "proxy.js", vbTextCompare) > 0 Then p.Terminate()
    End If
  Next
End Sub

port = ConfigMatch("""port""\s*:\s*(\d+)")
If port = "" Then port = "8787"
exitMode = LCase(ConfigMatch("""exit_with_client""\s*:\s*""(\w+)"""))

started = False
rc = sh.Run("cmd /c netstat -an | findstr /c:"":" & port & " "" | findstr /c:LISTENING >nul", 0, True)
If rc <> 0 Then
  sh.Run """" & node & """ """ & HERE & "\proxy.js""", 0, False
  started = True
  WScript.Sleep 1200
End If

sh.Run "explorer.exe shell:AppsFolder\" & appId, 0, False

If started Or exitMode = "always" Then
  WScript.Sleep 15000 ' let Desktop come up before watching for exit
  Do While DesktopRunning()
    WScript.Sleep 5000
  Loop
  WScript.Sleep 2000
  If Not DesktopRunning() Then
    If fso.FileExists(HERE & "\proxy.pid") Then
      Set f = fso.OpenTextFile(HERE & "\proxy.pid", 1)
      pid = Trim(f.ReadAll)
      f.Close
      If IsNumeric(pid) Then KillProxy pid
      fso.DeleteFile HERE & "\proxy.pid", True
    End If
  End If
End If
