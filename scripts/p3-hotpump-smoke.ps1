param(
    [string]$BaseUrl = "http://127.0.0.1:8787",
    [string]$ApiKey = $env:API_KEY,
    [string]$TokenId = "2",
    [string]$Pair = "0x1111111111111111111111111111111111111111",
    [string]$Target = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
    [string]$Data = "0xd0e30db0",
    [string]$Value = "1000000000000000",
    [int]$PumpThresholdBps = 10000,
    [int]$UniqueTradersMin = 200,
    [string]$MinVolume5m = "1000000000000000000"
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
            $jsonBody = if ($null -eq $Body) { "{}" } else { $Body | ConvertTo-Json -Depth 20 -Compress }
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

Write-Host "[1/6] Upsert hotpump_watchlist strategy for tokenId=$TokenId"
$strategyPayload = @{
    tokenId      = $TokenId
    strategyType = "hotpump_watchlist"
    target       = $Target
    data         = $Data
    value        = $Value
    enabled      = $true
    strategyParams = @{
        watchlistPairs    = @($Pair)
        pumpThresholdBps  = $PumpThresholdBps
        uniqueTradersMin  = $UniqueTradersMin
        minVolume5m       = $MinVolume5m
        signalMaxAgeMs    = 300000
        allowedTargets    = @($Target)
        allowedSelectors  = @($Data)
        maxValuePerRun    = $Value
    }
}
[void](Invoke-RunnerApi -Method POST -Path "/strategy/upsert" -Body $strategyPayload -RequireApiKey $true)

Write-Host "[2/6] Insert MISS signal"
$missSignal = @{
    pair             = $Pair
    priceChangeBps   = [Math]::Max(0, $PumpThresholdBps - 1)
    uniqueTraders5m  = [Math]::Max(0, $UniqueTradersMin - 1)
    volume5m         = $MinVolume5m
    source           = "smoke-miss"
}
[void](Invoke-RunnerApi -Method POST -Path "/market/signal" -Body $missSignal -RequireApiKey $true)

Write-Host "[3/6] Evaluate strategy (expect MISS)"
$evalMiss = Invoke-RunnerApi -Method GET -Path "/strategy/evaluate?tokenId=$TokenId"
if ($evalMiss.matched -eq $true) {
    throw "Expected MISS, but strategy matched. reason=$($evalMiss.reason)"
}

Write-Host "[4/6] Insert HIT signal"
$hitSignal = @{
    pair             = $Pair
    priceChangeBps   = $PumpThresholdBps + 200
    uniqueTraders5m  = $UniqueTradersMin + 20
    volume5m         = $MinVolume5m
    source           = "smoke-hit"
}
[void](Invoke-RunnerApi -Method POST -Path "/market/signal" -Body $hitSignal -RequireApiKey $true)

Write-Host "[5/6] Evaluate strategy (expect HIT)"
$evalHit = Invoke-RunnerApi -Method GET -Path "/strategy/evaluate?tokenId=$TokenId"
if ($evalHit.matched -ne $true) {
    throw "Expected HIT, but strategy did not match. reason=$($evalHit.reason)"
}
if ($null -eq $evalHit.action) {
    throw "Expected action in HIT result, but action is null."
}

Write-Host "[6/6] Read /health"
$health = Invoke-RunnerApi -Method GET -Path "/health"

$summary = [ordered]@{
    ok = $true
    tokenId = $TokenId
    pair = $Pair
    missReason = $evalMiss.reason
    hitReason = $evalHit.reason
    health = @{
        enabledCount = $health.enabledCount
        activeLockCount = $health.activeLockCount
        marketSignalSync = $health.marketSignalSync
    }
}

Write-Host "Smoke passed."
$summary | ConvertTo-Json -Depth 10
