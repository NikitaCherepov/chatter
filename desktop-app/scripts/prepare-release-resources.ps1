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

try {
  $whisperExe = Join-Path $modelsDirectory 'whisper.exe'
  if ($Force -or -not (Test-Path -LiteralPath $whisperExe)) {
    $archive = Join-Path $tempDirectory 'whisper.zip'
    $expanded = Join-Path $tempDirectory 'whisper'
    Download-File `
      -Url "https://github.com/ggml-org/whisper.cpp/releases/download/v$whisperVersion/whisper-bin-x64.zip" `
      -Destination $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force

    $sourceExe = Get-ChildItem -LiteralPath $expanded -Recurse -File |
      Where-Object { $_.Name -in 'whisper-cli.exe', 'main.exe' } |
      Select-Object -First 1
    if (-not $sourceExe) { throw 'The Whisper archive does not contain whisper-cli.exe or main.exe.' }

    Copy-Item -LiteralPath $sourceExe.FullName -Destination $whisperExe -Force
    Get-ChildItem -LiteralPath $sourceExe.Directory.FullName -Filter '*.dll' -File |
      Copy-Item -Destination $modelsDirectory -Force
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
