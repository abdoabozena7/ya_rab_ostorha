param(
    [switch]$Check,
    [switch]$NoBrowser,
    [ValidateRange(1, 65535)]
    [int]$Port = 8000
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start-YA-RAB-OSTORHA.ps1') @PSBoundParameters
