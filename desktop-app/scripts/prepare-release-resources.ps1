param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$modelsDirectory = Join-Path $PSScriptRoot '..\models'
$whisperVersion = '1.8.6'
$piperVersion = '2023.11.14-2'
$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "chatter-desktop-resources-$([guid]::NewGuid())"

function Download-File {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Write-Host "Downloading $Url"
  & curl.exe --fail --location --retry 3 --retry-delay 2 --output $Destination $Url
  if ($LASTEXITCODE -ne 0) {
    throw "Download failed with exit code $LASTEXITCODE`: $Url"
  }
}

New-Item -ItemType Directory -Force -Path $modelsDirectory, $tempDirectory | Out-Null

function Find-WhisperCli {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [switch]$Recurse
  )

  $knownNames = @(
    'whisper-whisper-cli.exe',
    'whisper-cli.exe',
    'whisper-main.exe',
    'main.exe',
    'whisper.exe'
  )

  Get-ChildItem -LiteralPath $Directory -File -Recurse:$Recurse |
    Where-Object {
      $_.Name -in $knownNames -and
      $_.Length -gt 64KB
    } |
    Sort-Object Length -Descending |
    Select-Object -First 1
}

try {
  $whisperExe = Find-WhisperCli -Directory $modelsDirectory
  if ($Force -or -not $whisperExe) {
    $archive = Join-Path $tempDirectory 'whisper.zip'
    $expanded = Join-Path $tempDirectory 'whisper'
    Download-File `
      -Url "https://github.com/ggml-org/whisper.cpp/releases/download/v$whisperVersion/whisper-bin-x64.zip" `
      -Destination $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force

    $sourceExe = Find-WhisperCli -Directory $expanded -Recurse
    if (-not $sourceExe) { throw 'The Whisper archive does not contain a working CLI executable.' }

    $whisperExe = Join-Path $modelsDirectory $sourceExe.Name
    Copy-Item -LiteralPath $sourceExe.FullName -Destination $whisperExe -Force
    Get-ChildItem -LiteralPath $sourceExe.Directory.FullName -Filter '*.dll' -File |
      Copy-Item -Destination $modelsDirectory -Force
  } else {
    $whisperExe = $whisperExe.FullName
  }

  $whisperCheckInfo = New-Object System.Diagnostics.ProcessStartInfo
  $whisperCheckInfo.FileName = $whisperExe
  $whisperCheckInfo.Arguments = '--help'
  $whisperCheckInfo.UseShellExecute = $false
  $whisperCheckInfo.CreateNoWindow = $true
  $whisperCheckInfo.RedirectStandardOutput = $true
  $whisperCheckInfo.RedirectStandardError = $true
  $whisperCheck = [System.Diagnostics.Process]::Start($whisperCheckInfo)
  $whisperCheck.BeginOutputReadLine()
  $whisperCheck.BeginErrorReadLine()
  $whisperCheck.WaitForExit()
  if ($whisperCheck.ExitCode -ne 0) {
    throw "The selected Whisper CLI failed its startup check: $whisperExe"
  }

  $whisperModel = Join-Path $modelsDirectory 'ggml-small.bin'
  if ($Force -or -not (Test-Path -LiteralPath $whisperModel)) {
    Download-File `
      -Url 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin?download=true' `
      -Destination $whisperModel
  }

  $piperDirectory = Join-Path $modelsDirectory 'piper'
  $piperExe = Join-Path $piperDirectory 'piper.exe'
  if ($Force -or -not (Test-Path -LiteralPath $piperExe)) {
    $archive = Join-Path $tempDirectory 'piper.zip'
    $expanded = Join-Path $tempDirectory 'piper'
    Download-File `
      -Url "https://github.com/rhasspy/piper/releases/download/$piperVersion/piper_windows_amd64.zip" `
      -Destination $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force

    $sourceExe = Get-ChildItem -LiteralPath $expanded -Recurse -Filter 'piper.exe' -File | Select-Object -First 1
    if (-not $sourceExe) { throw 'The Piper archive does not contain piper.exe.' }

    Remove-Item -LiteralPath $piperDirectory -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $piperDirectory | Out-Null
    Copy-Item -Path (Join-Path $sourceExe.Directory.FullName '*') -Destination $piperDirectory -Recurse -Force
  }

  & (Join-Path $PSScriptRoot 'download-default-piper-voices.ps1') -Force:$Force
  if ($LASTEXITCODE -ne 0) { throw 'Default Piper voice download failed.' }

  $requiredFiles = @(
    $whisperExe,
    $whisperModel,
    $piperExe,
    (Join-Path $modelsDirectory 'piper-voices\ruslan\ru_RU-ruslan-medium.onnx'),
    (Join-Path $modelsDirectory 'piper-voices\irina\ru_RU-irina-medium.onnx'),
    (Join-Path $modelsDirectory 'piper-voices\hfc_male\en_US-hfc_male-medium.onnx'),
    (Join-Path $modelsDirectory 'piper-voices\hfc_female\en_US-hfc_female-medium.onnx')
  )
  $missingFiles = $requiredFiles | Where-Object { -not (Test-Path -LiteralPath $_) }
  if ($missingFiles) {
    throw "Desktop release resources are incomplete: $($missingFiles -join ', ')"
  }

  Write-Host 'Desktop release resources are ready.'
} finally {
  Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
