<#
.SYNOPSIS
  Builds the Windows release zip: release\Dwarfwatch-v<version>-win-x64.zip.

.DESCRIPTION
  Runs the tests, publishes the overlay as one self-contained exe (it includes .NET, so users only need
  Node.js), puts it next to the server and page files, and zips that folder. It only builds: tagging and
  uploading the release to GitHub stay a manual step (the commands are printed at the end).

.PARAMETER Version
  The version to build, without a leading "v". Defaults to the version in package.json.

.EXAMPLE
  .\scripts\release.ps1
#>
param([string]$Version)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Version) { $Version = (Get-Content package.json -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version '$Version' is not of the form 1.2.3" }

$dirty = git status --porcelain
if ($dirty) { Write-Warning "The working tree has uncommitted changes; the build will include them." }

Write-Host "Running the tests..."
node --test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }

$out = Join-Path $root 'release'
$build = Join-Path $out 'build'
$stage = Join-Path $out 'Dwarfwatch'
$zip = Join-Path $out "Dwarfwatch-v$Version-win-x64.zip"
foreach ($p in @($build, $stage, $zip)) { if (Test-Path $p) { Remove-Item $p -Recurse -Force } }

Write-Host "Publishing the overlay $Version..."
dotnet publish overlay -c Release -r win-x64 --self-contained `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
  -p:Version=$Version -o $build
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $build 'Dwarfwatch.exe') $stage
$files = @('server.js', 'mine.js', 'index.html', 'README.md', 'usage-calibration.example.json', 'LICENSE')
foreach ($f in $files) { if (Test-Path $f) { Copy-Item $f $stage } }

Compress-Archive -Path $stage -DestinationPath $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)

Write-Host ""
Write-Host "Built $zip ($size MB)"
Write-Host "SHA-256 $hash"
Write-Host ""
Write-Host "To publish it (after committing and pushing):"
Write-Host "  git tag v$Version"
Write-Host "  git push origin v$Version"
Write-Host "  gh release create v$Version `"$zip`" --title `"Dwarfwatch $Version`" --notes-file <notes.md>"
