param([Parameter(Mandatory=$true)][string]$Stage,[Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference = 'Stop'
$entries = Get-ChildItem -LiteralPath $Stage -Force | Select-Object -ExpandProperty FullName
Compress-Archive -LiteralPath $entries -DestinationPath $Archive -Force
