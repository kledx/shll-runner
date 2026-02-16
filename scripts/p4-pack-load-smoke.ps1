param(
    [string]$BaseUrl = "http://127.0.0.1:8787",
    [string]$ApiKey = $env:API_KEY,
    [string]$TokenId = $(if ($env:TOKEN_ID) { $env:TOKEN_ID } else { "0" }),
    [string]$LegacyPackPath = (Join-Path $PSScriptRoot "..\capability-pack.sample.json"),
    [string]$ManifestPackPath = (Join-Path $PSScriptRoot "..\..\shll-packs-private\base_trader\1.1.0\manifest.json"),
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw "API key is required. Pass -ApiKey or set API_KEY env."
}

function Invoke-RunnerApi {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("GET", "POST")]
        [string]$Method,
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter()]
        [object]$Body,
        [Parameter()]
        [bool]$RequireApiKey = $false
    )

    $uri = "$BaseUrl$Path"
    $headers = @{
        Accept = "application/json"
    }
    if ($RequireApiKey) {
        $headers["x-api-key"] = $ApiKey
    }
    if ($Method -eq "POST") {
        $headers["Content-Type"] = "application/json"
    }

    try {
        if ($Method -eq "POST") {
            $jsonBody = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Depth 100 -Compress }
            return Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $jsonBody
        }
        return Invoke-RestMethod -Method Get -Uri $uri -Headers $headers
    } catch {
        $err = $_
        $message = $err.Exception.Message
        if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
            $message = "$message`n$($err.ErrorDetails.Message)"
        }
        throw "Request failed: $Method $Path`n$message"
    }
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "File not found: $Path"
    }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

Write-Host "[1/4] Load legacy strategy pack (dryRun=true)"
$legacyPack = Read-JsonFile -Path $LegacyPackPath
$legacyResult = Invoke-RunnerApi -Method POST -Path "/strategy/load-pack" -RequireApiKey $true -Body @{
    pack = $legacyPack
    dryRun = $true
}

if ($legacyResult.ok -ne $true) {
    throw "Legacy load-pack expected ok=true."
}
if ($legacyResult.packKind -ne "strategy_pack") {
    throw "Legacy load-pack expected packKind=strategy_pack, got: $($legacyResult.packKind)"
}

Write-Host "[2/4] Load manifest v1.1 pack (dryRun=true)"
$manifestPack = Read-JsonFile -Path $ManifestPackPath
$manifestDryRun = Invoke-RunnerApi -Method POST -Path "/strategy/load-pack" -RequireApiKey $true -Body @{
    pack = $manifestPack
    tokenIds = @($TokenId)
    dryRun = $true
}

if ($manifestDryRun.ok -ne $true) {
    throw "Manifest dry-run expected ok=true."
}
if ($manifestDryRun.packKind -ne "manifest_pack") {
    throw "Manifest dry-run expected packKind=manifest_pack, got: $($manifestDryRun.packKind)"
}
if ("$($manifestDryRun.schemaVersion)" -ne "1.1") {
    throw "Manifest dry-run expected schemaVersion=1.1, got: $($manifestDryRun.schemaVersion)"
}

$applyResult = $null
$strategyReadback = $null
if ($Apply.IsPresent) {
    Write-Host "[3/4] Apply manifest pack (dryRun=false)"
    $applyResult = Invoke-RunnerApi -Method POST -Path "/strategy/load-pack" -RequireApiKey $true -Body @{
        pack = $manifestPack
        tokenIds = @($TokenId)
        dryRun = $false
    }
    if ($applyResult.ok -ne $true) {
        throw "Manifest apply expected ok=true."
    }

    Write-Host "[4/4] Read back strategy for tokenId=$TokenId"
    $strategyReadback = Invoke-RunnerApi -Method GET -Path "/strategy?tokenId=$TokenId"
    if ($strategyReadback.ok -ne $true) {
        throw "Strategy readback expected ok=true."
    }
} else {
    Write-Host "[3/4] Skip apply (use -Apply for write test)"
    Write-Host "[4/4] Done (dry-run only)"
}

$summary = [ordered]@{
    ok = $true
    baseUrl = $BaseUrl
    tokenId = $TokenId
    files = [ordered]@{
        legacyPackPath = $LegacyPackPath
        manifestPackPath = $ManifestPackPath
    }
    legacy = [ordered]@{
        packKind = $legacyResult.packKind
        appliedCount = [int]$legacyResult.appliedCount
        skippedCount = [int]$legacyResult.skippedCount
    }
    manifestDryRun = [ordered]@{
        packKind = $manifestDryRun.packKind
        schemaVersion = $manifestDryRun.schemaVersion
        appliedCount = [int]$manifestDryRun.appliedCount
        skippedCount = [int]$manifestDryRun.skippedCount
    }
    applied = [bool]$Apply.IsPresent
}

if ($Apply.IsPresent) {
    $summary["manifestApply"] = [ordered]@{
        appliedCount = [int]$applyResult.appliedCount
        skippedCount = [int]$applyResult.skippedCount
    }
    $summary["strategy"] = $strategyReadback.strategy
}

Write-Host "Pack load smoke passed."
$summary | ConvertTo-Json -Depth 20
