param(
    [string]$BaseUrl = "http://127.0.0.1:8787",
    [string]$ApiKey = $env:API_KEY,
    [int]$MinAcceptedDryRun = 1,
    [int]$MinAcceptedWrite = 1,
    [int]$MinUpsertedWrite = 1,
    [int]$ReadbackLimit = 20
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

function To-Int {
    param(
        [Parameter()]
        [object]$Value,
        [Parameter()]
        [int]$Default = 0
    )

    if ($null -eq $Value) {
        return $Default
    }
    return [int]$Value
}

Write-Host "[1/4] Sync from source (dryRun=true)"
$dryRunResult = Invoke-RunnerApi -Method POST -Path "/market/signal/sync" -Body @{ dryRun = $true } -RequireApiKey $true

if ($dryRunResult.ok -ne $true) {
    throw "Expected dry-run response ok=true."
}

$dryAccepted = To-Int -Value $dryRunResult.accepted
$drySkipped = To-Int -Value $dryRunResult.skipped
$dryUpserted = To-Int -Value $dryRunResult.upserted
if ($dryUpserted -ne 0) {
    throw "Dry-run must not upsert records. got upserted=$dryUpserted"
}
if ($dryAccepted -lt $MinAcceptedDryRun) {
    throw "Dry-run accepted=$dryAccepted is below MinAcceptedDryRun=$MinAcceptedDryRun"
}

Write-Host "[2/4] Sync from source (dryRun=false)"
$writeResult = Invoke-RunnerApi -Method POST -Path "/market/signal/sync" -Body @{ dryRun = $false } -RequireApiKey $true

if ($writeResult.ok -ne $true) {
    throw "Expected write-run response ok=true."
}

$writeAccepted = To-Int -Value $writeResult.accepted
$writeSkipped = To-Int -Value $writeResult.skipped
$writeUpserted = To-Int -Value $writeResult.upserted
if ($writeAccepted -lt $MinAcceptedWrite) {
    throw "Write-run accepted=$writeAccepted is below MinAcceptedWrite=$MinAcceptedWrite"
}
if ($writeUpserted -lt $MinUpsertedWrite) {
    throw "Write-run upserted=$writeUpserted is below MinUpsertedWrite=$MinUpsertedWrite"
}

Write-Host "[3/4] Read back market signal records"
$signals = Invoke-RunnerApi -Method GET -Path "/market/signal?limit=$ReadbackLimit"
if ($signals.ok -ne $true) {
    throw "Expected /market/signal response ok=true."
}
$signalCount = To-Int -Value $signals.count
if ($signalCount -le 0) {
    throw "Expected at least 1 market signal record after write-run."
}

Write-Host "[4/4] Read /health"
$health = Invoke-RunnerApi -Method GET -Path "/health"

$summary = [ordered]@{
    ok = $true
    dryRun = [ordered]@{
        accepted = $dryAccepted
        skipped = $drySkipped
        upserted = $dryUpserted
    }
    writeRun = [ordered]@{
        accepted = $writeAccepted
        skipped = $writeSkipped
        upserted = $writeUpserted
    }
    readback = [ordered]@{
        limit = $ReadbackLimit
        count = $signalCount
    }
    health = [ordered]@{
        enabledCount = $health.enabledCount
        activeLockCount = $health.activeLockCount
        marketSignalSync = $health.marketSignalSync
    }
}

Write-Host "Signal sync smoke passed."
$summary | ConvertTo-Json -Depth 10
