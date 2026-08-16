# One-off: generate public/fleexbid-logo.png (full logo) and public/favicon.png
# (square, icon-only crop of the truck-F mark) from the pasted source image.
param(
  [string]$Source = 'C:\Users\Alisha\AppData\Local\Temp\freebuff-desktop-pastes\paste-1786902047418-5832.png',
  [string]$OutDir = 'public'
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

# 1. Full logo copy
Copy-Item $Source (Join-Path $OutDir 'fleexbid-logo.png') -Force
Write-Output "copied full logo -> $OutDir/fleexbid-logo.png"

# 2. Analyze rows: count non-white pixels per row
$img = [System.Drawing.Bitmap]::new($Source)
$w = $img.Width
$h = $img.Height
$rows = New-Object 'int[]' $h
$isDark = {
  param($p)
  ($p.R -lt 235) -or ($p.G -lt 235) -or ($p.B -lt 235)
}
for ($y = 0; $y -lt $h; $y++) {
  $cnt = 0
  for ($x = 0; $x -lt $w; $x++) {
    if (& $isDark $img.GetPixel($x, $y)) { $cnt++ }
  }
  $rows[$y] = $cnt
}

# Top content row
$top = -1
for ($y = 0; $y -lt $h; $y++) {
  if ($rows[$y] -gt 5) { $top = $y; break }
}
if ($top -lt 0) { throw 'no content found in image' }

# Find the first gap >= 12 empty rows (the whitespace between icon and wordmark)
$cropBottom = $h
$y = $top
while ($y -lt $h) {
  if ($rows[$y] -le 5) {
    $g = 0
    while (($y + $g) -lt $h -and $rows[$y + $g] -le 5) { $g++ }
    if ($g -ge 12) { $cropBottom = $y; break }
    $y += $g
  } else {
    $y++
  }
}
Write-Output "icon crop rows: top=$top bottom=$cropBottom (of $h)"

# Left/right bounds within the icon region
$left = $w; $right = 0
for ($x = 0; $x -lt $w; $x++) {
  for ($y2 = $top; $y2 -lt $cropBottom; $y2++) {
    if (& $isDark $img.GetPixel($x, $y2)) {
      if ($x -lt $left) { $left = $x }
      if ($x -gt $right) { $right = $x }
    }
  }
}
$contentW = $right - $left + 1
$contentH = $cropBottom - $top
Write-Output "icon content box: left=$left right=$right w=$contentW h=$contentH"

# Square canvas, content centered on white
$side = [Math]::Max($contentW, $contentH)
$canvas = [System.Drawing.Bitmap]::new($side, $side)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.Clear([System.Drawing.Color]::White)
$destX = [int](($side - $contentW) / 2)
$destY = [int](($side - $contentH) / 2)
$srcRect = [System.Drawing.Rectangle]::new($left, $top, $contentW, $contentH)
$destRect = [System.Drawing.Rectangle]::new($destX, $destY, $contentW, $contentH)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()

# Resize to 512 for crisp favicon
$final = [System.Drawing.Bitmap]::new($canvas, [System.Drawing.Size]::new(512, 512))
$final.Save((Join-Path $OutDir 'favicon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "wrote $OutDir/favicon.png (512x512)"

$img.Dispose()
$canvas.Dispose()
$final.Dispose()
