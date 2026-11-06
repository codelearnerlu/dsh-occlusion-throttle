param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [int]$IntervalMs = 500
)

$ErrorActionPreference = 'SilentlyContinue'

$csPath = Join-Path $PSScriptRoot 'occlusion-watcher.cs'
Add-Type -Path $csPath

# 物理像素坐标，避免高 DPI 缩放下 WindowFromPoint 与 GetWindowRect 不一致
[void][OccDpi]::SetProcessDPIAware()

$last = ''
$lastEmit = [DateTime]::UtcNow
$heartbeatMs = 2500
while ($true) {
  $h = [OccWin]::LargestWindow([uint32]$TargetPid)
  $state = 'nowindow'
  $hits = 0
  $total = 0
  $rect = ''

  if ($h -eq [IntPtr]::Zero) {
    $state = 'nowindow'
  }
  elseif ([OccWin]::IsIconic($h)) {
    $state = 'minimized'
  }
  elseif (-not [OccWin]::IsWindowVisible($h)) {
    $state = 'hidden'
  }
  else {
    $r = New-Object OccWin+RECT
    [void][OccWin]::GetWindowRect($h, [ref]$r)
    $vl = [OccWin]::GetSystemMetrics(76)
    $vt = [OccWin]::GetSystemMetrics(77)
    $vw = [OccWin]::GetSystemMetrics(78)
    $vh = [OccWin]::GetSystemMetrics(79)
    $l = [Math]::Max($r.L, $vl)
    $t = [Math]::Max($r.T, $vt)
    $rr = [Math]::Min($r.R, $vl + $vw)
    $bb = [Math]::Min($r.B, $vt + $vh)
    $w = $rr - $l
    $ht = $bb - $t
    $rect = "$l,$t,$rr,$bb"

    if ($w -le 8 -or $ht -le 8) {
      $state = 'nowindow'
    }
    else {
      # 快路径：中心点属于自己 → 直接判可见（16 次采样降到 1 次）
      $cx = [int]($l + $w * 0.5)
      $cy = [int]($t + $ht * 0.5)
      $center = New-Object OccWin+POINT
      $center.X = $cx
      $center.Y = $cy
      $centerWin = [OccWin]::WindowFromPoint($center)
      if ($centerWin -ne [IntPtr]::Zero -and [OccWin]::RootPid($centerWin) -eq [uint32]$TargetPid) {
        $state = 'visible'
        $hits = 1
        $total = 1
      }
      else {
        foreach ($fx in 0.2, 0.4, 0.6, 0.8) {
          foreach ($fy in 0.2, 0.4, 0.6, 0.8) {
            $pt = New-Object OccWin+POINT
            $pt.X = [int]($l + $w * $fx)
            $pt.Y = [int]($t + $ht * $fy)
            $win = [OccWin]::WindowFromPoint($pt)
            $total++
            if ($win -ne [IntPtr]::Zero -and [OccWin]::RootPid($win) -eq [uint32]$TargetPid) {
              $hits++
            }
          }
        }
        if ($hits -gt 0) { $state = 'visible' } else { $state = 'occluded' }
      }
    }
  }

  $fgPid = [uint32]0
  $fgh = [OccWin]::GetForegroundWindow()
  if ($fgh -ne [IntPtr]::Zero) { [void][OccWin]::GetWindowThreadProcessId($fgh, [ref]$fgPid) }
  $focused = ($fgPid -eq [uint32]$TargetPid)

  $payload = [pscustomobject]@{
    state   = $state
    focused = $focused
    hits    = $hits
    total   = $total
    rect    = $rect
  }
  $line = $payload | ConvertTo-Json -Compress
  $changed = ($line -ne $last)
  $stale = (([DateTime]::UtcNow) - $lastEmit).TotalMilliseconds -ge $heartbeatMs
  if ($changed -or $stale) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
    $last = $line
    $lastEmit = [DateTime]::UtcNow
  }
  Start-Sleep -Milliseconds $IntervalMs
}
