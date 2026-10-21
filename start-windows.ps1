param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This launcher requires Windows.' }
$node = Get-Command node.exe -CommandType Application -ErrorAction Stop
$major = & $node.Source -p 'Number(process.versions.node.split(".")[0])'
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 20) { throw 'Please install Node.js 20 or newer.' }
$bridge = Join-Path $PSScriptRoot 'bridge.mjs'
if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) { throw 'Bridge file is missing.' }
# The public extension ID is explicit; this does not trust the first caller.
# API keys never enter this script or process arguments.
$previousId = $env:JIEYIJU_EXTENSION_ID
try {
  $env:JIEYIJU_EXTENSION_ID = $ExtensionId
  & $node.Source $bridge
  if ($LASTEXITCODE -ne 0) { throw 'Local service stopped. Check the fixed error shown above.' }
} finally {
  if ($null -eq $previousId) { Remove-Item Env:JIEYIJU_EXTENSION_ID -ErrorAction SilentlyContinue }
  else { $env:JIEYIJU_EXTENSION_ID = $previousId }
}
