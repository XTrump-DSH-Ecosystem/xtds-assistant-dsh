Option Explicit

Const APP_TITLE = "SnowLuma hidden launcher"
Const DEFAULT_HOME = "E:\SnowLuma"

Dim fso
Dim shell
Dim homeDir
Dim entryScript
Dim nodeExe
Dim commandLine
Dim launchError

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

homeDir = Trim(EnvValue("SNOWLUMA_HOME"))
If Len(homeDir) = 0 Then homeDir = DEFAULT_HOME

If Not fso.FolderExists(homeDir) Then
  ShowError "SnowLuma directory not found:" & vbCrLf & homeDir & vbCrLf & vbCrLf & _
    "Set SNOWLUMA_HOME to the directory containing index.mjs."
  WScript.Quit 1
End If
homeDir = fso.GetAbsolutePathName(homeDir)

entryScript = fso.BuildPath(homeDir, "index.mjs")
If Not fso.FileExists(entryScript) Then
  ShowError "SnowLuma entry script not found:" & vbCrLf & entryScript & vbCrLf & vbCrLf & _
    "Confirm that the selected SnowLuma directory contains index.mjs."
  WScript.Quit 1
End If

nodeExe = Trim(EnvValue("SNOWLUMA_NODE"))
If Len(nodeExe) = 0 Then nodeExe = fso.BuildPath(homeDir, "node.exe")

If Not fso.FileExists(nodeExe) Then
  ShowError "Node executable not found:" & vbCrLf & nodeExe & vbCrLf & vbCrLf & _
    "Place node.exe in the SnowLuma directory or set SNOWLUMA_NODE to node.exe."
  WScript.Quit 1
End If
nodeExe = fso.GetAbsolutePathName(nodeExe)

commandLine = QuoteArg(nodeExe) & " " & QuoteArg(entryScript)

On Error Resume Next
shell.CurrentDirectory = homeDir
If Err.Number <> 0 Then
  launchError = Err.Description
  Err.Clear
  On Error GoTo 0
  ShowError "Could not set the SnowLuma working directory:" & vbCrLf & homeDir & vbCrLf & _
    "Error: " & launchError
  WScript.Quit 1
End If

shell.Run commandLine, 0, False
If Err.Number <> 0 Then
  launchError = Err.Description
  Err.Clear
  On Error GoTo 0
  ShowError "Could not launch SnowLuma:" & vbCrLf & commandLine & vbCrLf & _
    "Error: " & launchError
  WScript.Quit 1
End If
On Error GoTo 0

Sub ShowError(message)
  MsgBox message, vbCritical, APP_TITLE
End Sub

Function EnvValue(name)
  Dim marker
  Dim value

  marker = "%" & name & "%"
  value = shell.ExpandEnvironmentStrings(marker)
  If StrComp(value, marker, vbBinaryCompare) = 0 Then
    EnvValue = ""
  Else
    EnvValue = Trim(value)
  End If
End Function

Function QuoteArg(value)
  QuoteArg = Chr(34) & value & Chr(34)
End Function
