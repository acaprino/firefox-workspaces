param([Parameter(Mandatory=$true)][string]$Artifact, [switch]$Signed)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$releaseRoot = (Get-Location).Path
$releaseFile = (Resolve-Path -LiteralPath $Artifact).Path
$zip = [System.IO.Compression.ZipFile]::OpenRead($releaseFile)
try {
  $signatureFiles = @()
  $verified = 0
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if ($name.EndsWith('/')) { continue }
    if ($name -match '^META-INF/') { $signatureFiles += $name; continue }
    if ($name -notmatch '^(manifest\.json|backend/[^/]+\.js|popup/.+|icons/.+)$' -or $name.Contains('..')) {
      throw "Unexpected packaged file: $name"
    }
    $source = Join-Path $releaseRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Source missing: $name" }
    $stream = $entry.Open()
    try {
      $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
      try { $digest = [Convert]::ToHexString($hashAlgorithm.ComputeHash($stream)) }
      finally { $hashAlgorithm.Dispose() }
    } finally { $stream.Dispose() }
    if ($digest -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) {
      # Mozilla signing may change manifest indentation and its final newline.
      $sameManifest = $false
      if ($Signed -and $name -eq 'manifest.json') {
        $manifestReader = [System.IO.StreamReader]::new($entry.Open())
        try { $packedManifest = $manifestReader.ReadToEnd() } finally { $manifestReader.Dispose() }
        $packedJson = $packedManifest | ConvertFrom-Json | ConvertTo-Json -Depth 100 -Compress
        $sourceJson = Get-Content -LiteralPath $source -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 100 -Compress
        $sameManifest = $packedJson -ceq $sourceJson
      }
      if (-not $sameManifest) { throw "Packaged content differs from release source: $name" }
    }
    $verified++
  }
  $manifestEntry = $zip.GetEntry('manifest.json')
  $reader = [System.IO.StreamReader]::new($manifestEntry.Open())
  try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  $sourceManifest = Get-Content -LiteralPath (Join-Path $releaseRoot 'manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.version -ne $sourceManifest.version -or $manifest.browser_specific_settings.gecko.id -ne 'workspaces@hardfox') {
    throw 'Unexpected release identity or version'
  }
  if ($Signed -and ($signatureFiles -notcontains 'META-INF/mozilla.rsa' -or $signatureFiles -notcontains 'META-INF/manifest.mf')) {
    throw 'Mozilla signature files missing'
  }
  [pscustomobject]@{
    artifact = $releaseFile
    version = $manifest.version
    verifiedSourceFiles = $verified
    bytes = (Get-Item -LiteralPath $releaseFile).Length
    sha256 = (Get-FileHash -LiteralPath $releaseFile -Algorithm SHA256).Hash.ToLowerInvariant()
    signatureFiles = $signatureFiles
  } | ConvertTo-Json -Compress
} finally { $zip.Dispose() }
