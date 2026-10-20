<#
  Run the Sweatbox when Windows starts (before anyone logs in) on http://127.0.0.1:3000, for a
  Cloudflare tunnel to put on the domain. From the repository folder:

    pnpm autostart                      build, install the startup task and start it now
    pnpm autostart -TunnelToken <token> the same, and install cloudflared as a service with that tunnel
    pnpm autostart -Restart             after changing the code: rebuild, then restart
    pnpm autostart -Status              is it running? (plus the end of the log)
    pnpm autostart -Stop
    pnpm autostart -Uninstall

  Installing, restarting, stopping and uninstalling ask for administrator rights (a UAC prompt).
  The task runs scripts/serve.mjs as SYSTEM; its log is var/logs/sweatbox.log.
#>
param(
  [switch]$Status,
  [switch]$Restart,
  [switch]$Stop,
  [switch]$Uninstall,
  [string]$TunnelToken = "",
  [switch]$NoBuild,
  [switch]$Elevated
)
$ErrorActionPreference = "Stop"
$TaskName = "ATC24Academy Sweatbox"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Serve = Join-Path $Root "scripts\serve.mjs"
$PidFile = Join-Path $Root "var\serve.pid"
$LogFile = Join-Path $Root "var\logs\sweatbox.log"
$Port = 3000
$envFile = Join-Path $Root ".env"
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^PORT=(\d+)\s*$' | Select-Object -First 1
  if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
}

function Test-Healthy {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/api/health").StatusCode -eq 200 } catch { return $false }
}

function Wait-Healthy([int]$Seconds = 60) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-Healthy) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Show-Status {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Write-Host "Startup task: $($task.State)" } else { Write-Host "Startup task: not installed" }
  if (Test-Healthy) { Write-Host "Sweatbox: running on http://127.0.0.1:$Port" } else { Write-Host "Sweatbox: not answering on port $Port" }
  $cf = Get-Service -Name cloudflared -ErrorAction SilentlyContinue
  if ($cf) { Write-Host "cloudflared service: $($cf.Status)" }
  if (Test-Path $LogFile) {
    Write-Host "`n--- last lines of $LogFile"
    Get-Content $LogFile -Tail 15
  }
}

function Stop-Sweatbox {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  # ending the task leaves the server process running on Windows: stop serve.mjs and its child
  if (Test-Path $PidFile) {
    $procId = [int](Get-Content $PidFile -Raw)
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    if ($p -and $p.CommandLine -like "*serve.mjs*") { & taskkill.exe /PID $procId /T /F | Out-Null }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
  }
}

function Invoke-Build {
  if ($NoBuild) { return }
  Write-Host "Building..."
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
  Push-Location $Root
  try {
    & corepack pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
  } finally { Pop-Location }
}

if ($Status) { Show-Status; exit 0 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  # build as you (not as SYSTEM), then do the rest with administrator rights
  if (-not $Stop -and -not $Uninstall) { Invoke-Build }
  $args2 = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Elevated", "-NoBuild")
  foreach ($s in "Restart", "Stop", "Uninstall") { if ((Get-Variable $s).Value) { $args2 += "-$s" } }
  if ($TunnelToken) { $args2 += @("-TunnelToken", $TunnelToken) }
  Write-Host "Asking for administrator rights..."
  $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $args2 -Wait -PassThru
  Show-Status
  exit $p.ExitCode
}

try {
  if ($Uninstall) {
    Stop-Sweatbox
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed: the Sweatbox no longer starts with Windows."
  } elseif ($Stop) {
    Stop-Sweatbox
    Write-Host "Stopped (it starts again at the next boot)."
  } else {
    if (-not $Elevated) { Invoke-Build }
    if (-not (Test-Path (Join-Path $Root "apps\server\dist\index.js"))) { throw "There is no build: run pnpm build first" }
    $node = (Get-Command node).Source
    if (-not $Restart -or -not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
      $action = New-ScheduledTaskAction -Execute $node -Argument "`"$Serve`"" -WorkingDirectory $Root
      $trigger = New-ScheduledTaskTrigger -AtStartup
      $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
      $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description "ATC24Academy Sweatbox on http://127.0.0.1:$Port ($Root)" -Force | Out-Null
      Write-Host "Installed the startup task '$TaskName'."
    }
    Stop-Sweatbox
    if (Test-Healthy) { throw "Something else answers on port $Port (pnpm dev?). Stop it, then run this again." }
    Start-ScheduledTask -TaskName $TaskName
    if (Wait-Healthy) { Write-Host "The Sweatbox is running on http://127.0.0.1:$Port" } else { Write-Host "It didn't answer within 60 s: see $LogFile" }

    if ($TunnelToken) {
      $cf = Get-Command cloudflared -ErrorAction SilentlyContinue
      if (-not $cf) { throw "cloudflared isn't installed: winget install --id Cloudflare.cloudflared, then run this again" }
      if (Get-Service -Name cloudflared -ErrorAction SilentlyContinue) { & $cf.Source service uninstall | Out-Null }
      & $cf.Source service install $TunnelToken
      Write-Host "cloudflared runs as a Windows service with your tunnel."
    }
  }
} catch {
  Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
  if ($Elevated) { Read-Host "Press Enter to close" | Out-Null }
  exit 1
}
if ($Elevated) { Start-Sleep -Seconds 3 }
