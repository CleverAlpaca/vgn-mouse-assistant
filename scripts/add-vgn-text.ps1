# Composite large centered white "VGN" lettering that fills the icon.
# Usage: powershell -File scripts/add-vgn-text.ps1   (run make-icon.mjs first)
# ASCII-only comments: PowerShell 5.1 misparses BOM-less UTF-8 Chinese comments.
param(
  [string]$IconPath = "$PSScriptRoot\..\assets\icon.png"
)

Add-Type -AssemblyName System.Drawing

$bmp = [System.Drawing.Bitmap]::FromFile($IconPath)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Arial Black at 120px: measured cap advance ~1.02em/letter, total ~413px on the
# 512 canvas, leaving ~50px side margins. Vertical draw-y is calibrated so the
# cap block (height ~0.73em) lands optically centered.
$font = New-Object System.Drawing.Font('Arial Black', 120, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$fmt = New-Object System.Drawing.StringFormat([System.Drawing.StringFormatFlags]::GenericTypographic)

$letters = @('V', 'G', 'N')
$gap = 22
$widths = @()
$total = $gap * ($letters.Count - 1)
foreach ($l in $letters) {
  $w = $g.MeasureString($l, $font, [int]::MaxValue, $fmt).Width
  $widths += $w
  $total += $w
}

$x = (512 - $total) / 2
$y = 168
for ($i = 0; $i -lt $letters.Count; $i++) {
  $g.DrawString($letters[$i], $font, $brush, [single]$x, [single]$y, $fmt)
  $x += $widths[$i] + $gap
}

$g.Dispose()
$tmp = "$IconPath.tmp.png"
$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Move-Item -Force $tmp $IconPath
Write-Output "VGN text composited: $IconPath"
