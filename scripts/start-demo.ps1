$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..

if (-not $env:STAFF_USERNAME) { $env:STAFF_USERNAME = 'manager' }
if (-not $env:STAFF_PASSWORD) { $env:STAFF_PASSWORD = 'demo-password-123' }
if (-not $env:STAFF_SESSION_SECRET) { $env:STAFF_SESSION_SECRET = 'local-demo-session-secret' }

npm run build
$server = Start-Process npm -ArgumentList 'start' -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
      Invoke-WebRequest -Uri 'http://127.0.0.1:3000/restaurants/demo/summary' -UseBasicParsing | Out-Null
      $ready = $true
      break
    } catch {}
  }
  if (-not $ready) { throw 'LowQueue did not start on port 3000' }

  $demoUrl = if ($env:LOWQUEUE_URL) { $env:LOWQUEUE_URL.TrimEnd('/') } else { 'http://127.0.0.1:3000' }
  Start-Process "$demoUrl/?restaurant=demo"
  Start-Process "$demoUrl/?restaurant=demo&view=staff"
  npm run demo
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id }
}
