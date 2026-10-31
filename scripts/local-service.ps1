param([ValidateSet('start','stop','status','run','enable-autostart','disable-autostart')][string]$Action='start', [switch]$Quiet)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtimeRoot = Join-Path $projectRoot 'data\runtime'
$statePath = Join-Path $runtimeRoot 'service.json'
$stopPath = Join-Path $runtimeRoot 'stop.request'
function Say([string]$Message) { if (!$Quiet) { Write-Output $Message } }
function Read-State { if (Test-Path -LiteralPath $statePath) { try { return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch {} }; return $null }
function Owned-Process($Record, [string]$Kind) {
  if (!$Record) { return $false }
  $idValue = $Record.($Kind + 'Pid'); $startValue = $Record.($Kind + 'Start'); $exeValue = $Record.($Kind + 'Exe')
  if (!$idValue -or !$startValue -or !$exeValue) { return $false }
  try { $p = Get-Process -Id $idValue -ErrorAction Stop; return $p.StartTime.ToUniversalTime().ToString('o') -eq $startValue -and $p.Path -eq $exeValue } catch { return $false }
}
function Health {
  $servicePort = 3000
  $envPath = Join-Path $projectRoot '.env'
  if (Test-Path -LiteralPath $envPath) { $portLine = @(Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^PORT=\d+$' }); if ($portLine.Count) { $servicePort = [int]($portLine[-1].Substring(5)) } }
  try { return Invoke-RestMethod -Uri ('http://127.0.0.1:' + $servicePort + '/healthz') -TimeoutSec 2 } catch { return $null }
}
function Save-State($Record) {
  $temporaryState = $statePath + '.tmp'
  $Record | ConvertTo-Json | Set-Content -LiteralPath $temporaryState -Encoding UTF8
  Move-Item -LiteralPath $temporaryState -Destination $statePath -Force
}
if ($Action -eq 'enable-autostart' -or $Action -eq 'disable-autostart') {
  $startupRoot = [Environment]::GetFolderPath('Startup')
  if (!$startupRoot -or !(Test-Path -LiteralPath $startupRoot)) { throw 'Cannot find current-user Startup folder.' }
  $shortcutPath = Join-Path $startupRoot 'FatfishBot-Local.lnk'
  $shellLink = New-Object -ComObject WScript.Shell
  if ($Action -eq 'enable-autostart') {
    $link = $shellLink.CreateShortcut($shortcutPath)
    if ((Test-Path -LiteralPath $shortcutPath) -and $link.Arguments -and !$link.Arguments.Contains($PSCommandPath)) { throw 'Existing startup shortcut belongs to another project.' }
    $link.TargetPath = Join-Path $PSHOME 'powershell.exe'
    $link.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action start -Quiet'
    $link.WorkingDirectory = $projectRoot; $link.WindowStyle = 7; $link.Description = 'Start the local QQ Fatfish bot after Windows sign-in.'; $link.Save()
    Say '已设置：登录Windows后自动在后台启动大肥鱼。'
  } elseif (Test-Path -LiteralPath $shortcutPath) {
    $link = $shellLink.CreateShortcut($shortcutPath)
    if (!$link.Arguments.Contains($PSCommandPath)) { throw 'Startup shortcut is not owned by this project.' }
    Remove-Item -LiteralPath $shortcutPath
    Say '已取消大肥鱼开机自启。'
  }
  exit 0
}
if ($Action -eq 'status') {
  $record = Read-State; $health = Health
  if ($health -and $health.app -eq 'qq-deepseek-bot') {
    Say ('机器人正在运行；接入方式：' + $health.transport)
    if ($health.gateway) { Say ('QQ连接状态：' + $health.gateway.state) }
    Say ('后台守护：' + (Owned-Process $record 'supervisor'))
  } else { Say '机器人未运行，或正在启动；双击“启动大肥鱼”可以启动。' }
  exit 0
}
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if ($Action -eq 'stop') {
  $record = Read-State
  if (!(Owned-Process $record 'supervisor')) { Say '没有发现本项目的后台守护进程；若是手动运行，请在原窗口按Ctrl+C。'; exit 0 }
  Set-Content -LiteralPath $stopPath -Value 'stop' -Encoding ASCII
  Say '已请求关闭大肥鱼，正在完成当前任务并保存记忆。'; exit 0
}
if ($Action -eq 'start') {
  $lockStream = $null
  try {
    $lockStream = [IO.File]::Open((Join-Path $runtimeRoot 'start.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $record = Read-State
    if (Owned-Process $record 'supervisor') { Say '大肥鱼已经在后台运行，不会重复启动。'; exit 0 }
    $health = Health
    if ($health -and $health.app -eq 'qq-deepseek-bot') { Say '已有手动启动的机器人在运行，不会再启动一份。'; exit 0 }
    if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }
    $powerShellPath = Join-Path $PSHOME 'powershell.exe'
    $argsValue = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action run -Quiet'
    $managerLogs = Join-Path $projectRoot 'logs'
    New-Item -ItemType Directory -Force -Path $managerLogs | Out-Null
    $process = Start-Process -FilePath $powerShellPath -ArgumentList $argsValue -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $managerLogs 'supervisor.out.log') -RedirectStandardError (Join-Path $managerLogs 'supervisor.err.log')
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      $health = Health
      if ($health -and $health.app -eq 'qq-deepseek-bot') {
        if ($health.transport -ne 'websocket' -or $health.gateway.state -eq 'ready') { Say '大肥鱼已在后台启动，可以关闭这个窗口。'; exit 0 }
      }
      if ($process.HasExited) { break }
    }
    Say '已尝试后台启动；请双击“查看大肥鱼状态”，日志保存在项目的logs文件夹。'
  } finally { if ($lockStream) { $lockStream.Dispose() } }
  exit 0
}
# run：独立后台守护，最多自动重启三次；stop.request由Node正常退出流程处理。
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } elseif (Test-Path -LiteralPath 'E:\Node.js\node.exe') { 'E:\Node.js\node.exe' } else { throw 'Node.js not found.' }
$logsRoot = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Force -Path $logsRoot | Out-Null
$selfProcess = Get-Process -Id $PID
$record = [ordered]@{ supervisorPid=$PID; supervisorStart=$selfProcess.StartTime.ToUniversalTime().ToString('o'); supervisorExe=$selfProcess.Path; nodePid=0; nodeStart=''; nodeExe=$nodePath }
Save-State $record
$env:FATFISH_LOCAL_SERVICE = '1'
for ($attempt = 0; $attempt -lt 4; $attempt++) {
  if (Test-Path -LiteralPath $stopPath) { break }
  $logTag = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + $attempt
  $child = Start-Process -FilePath $nodePath -ArgumentList @('--env-file-if-exists=.env','src/index.js') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logsRoot ($logTag + '.out.log')) -RedirectStandardError (Join-Path $logsRoot ($logTag + '.err.log'))
  $record.nodePid = $child.Id; try { $record.nodeStart = $child.StartTime.ToUniversalTime().ToString('o') } catch { $record.nodeStart = '' }; Save-State $record
  $child.WaitForExit()
  if (Test-Path -LiteralPath $stopPath) { break }
  if ($attempt -lt 3) { Start-Sleep -Seconds 10 }
}
