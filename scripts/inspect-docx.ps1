# Read-only in-memory inspection of a DOCX reference document.
# Mirrors what `markforge check --reference-doc` is specified to report (SPEC.md 4.2.1):
# provenance, defined style names, numbering, and theme fonts. Nothing is extracted to disk.
param([Parameter(Mandatory=$true)][string]$Path)

Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
$zip = [System.IO.Compression.ZipFile]::OpenRead($Path)

function Get-Part([string]$name) {
  $e = $zip.Entries | Where-Object { $_.FullName -eq $name }
  if (-not $e) { return $null }
  $sr = New-Object System.IO.StreamReader($e.Open())
  $t = $sr.ReadToEnd(); $sr.Close(); return $t
}

Write-Output "=== PARTS ==="
$zip.Entries | Sort-Object FullName | ForEach-Object {
  Write-Output ("{0,9}  {1}" -f $_.Length, $_.FullName)
}

Write-Output ""
Write-Output "=== PROVENANCE (docProps) ==="
foreach ($p in @("docProps/core.xml", "docProps/app.xml")) {
  $x = Get-Part $p
  if ($x) { Write-Output "--- $p"; Write-Output $x }
}

Write-Output ""
Write-Output "=== STYLES DEFINED ==="
$styles = Get-Part "word/styles.xml"
if ($styles) {
  $doc = [xml]$styles
  $ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
  $ns.AddNamespace("w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main")
  $rows = @()
  foreach ($s in $doc.SelectNodes("//w:style", $ns)) {
    $rows += [pscustomobject]@{
      Type    = $s.GetAttribute("type", $ns.LookupNamespace("w"))
      StyleId = $s.GetAttribute("styleId", $ns.LookupNamespace("w"))
      Name    = $s.SelectSingleNode("w:name", $ns).GetAttribute("val", $ns.LookupNamespace("w"))
      BasedOn = $(if ($s.SelectSingleNode("w:basedOn", $ns)) { $s.SelectSingleNode("w:basedOn", $ns).GetAttribute("val", $ns.LookupNamespace("w")) } else { "" })
      Custom  = $s.GetAttribute("customStyle", $ns.LookupNamespace("w"))
    }
  }
  Write-Output ("total styles: {0}" -f $rows.Count)
  $rows | Sort-Object Type, Name | Format-Table -AutoSize | Out-String -Width 200
}

Write-Output ""
Write-Output "=== NUMBERING ==="
$num = Get-Part "word/numbering.xml"
if ($num) {
  $nd = [xml]$num
  $ns2 = New-Object System.Xml.XmlNamespaceManager($nd.NameTable)
  $ns2.AddNamespace("w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main")
  Write-Output ("abstractNum: {0}   num instances: {1}" -f `
    $nd.SelectNodes("//w:abstractNum", $ns2).Count, $nd.SelectNodes("//w:num", $ns2).Count)
  Write-Output ("startOverride count: {0}" -f $nd.SelectNodes("//w:startOverride", $ns2).Count)
} else { Write-Output "no numbering.xml" }

Write-Output ""
Write-Output "=== THEME FONTS ==="
$theme = Get-Part "word/theme/theme1.xml"
if ($theme) {
  [regex]::Matches($theme, '<a:(latin|ea|cs)\s+typeface="([^"]*)"') |
    ForEach-Object { $_.Groups[0].Value } | Select-Object -First 12
} else { Write-Output "no theme1.xml" }

Write-Output ""
Write-Output "=== BODY: styles actually used, with counts ==="
$docx = Get-Part "word/document.xml"
if ($docx) {
  [regex]::Matches($docx, '<w:pStyle w:val="([^"]+)"') |
    ForEach-Object { $_.Groups[1].Value } | Group-Object | Sort-Object Count -Descending |
    ForEach-Object { Write-Output ("{0,4}  {1}" -f $_.Count, $_.Name) }
  Write-Output ""
  Write-Output ("paragraphs: {0}   tables: {1}   direct rPr runs: {2}   OMML: {3}   drawings: {4}" -f `
    [regex]::Matches($docx, '<w:p[ >]').Count, [regex]::Matches($docx, '<w:tbl>').Count, `
    [regex]::Matches($docx, '<w:rPr>').Count, [regex]::Matches($docx, '<m:oMath').Count, `
    [regex]::Matches($docx, '<w:drawing>').Count)
}
$zip.Dispose()
