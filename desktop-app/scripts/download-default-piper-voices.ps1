param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$voices = @(
  @{
    Folder = 'ruslan'
    BaseUrl = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/ruslan/medium'
    Files = @('ru_RU-ruslan-medium.onnx', 'ru_RU-ruslan-medium.onnx.json', 'MODEL_CARD')
  },
  @{
    Folder = 'irina'
    BaseUrl = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/irina/medium'
    Files = @('ru_RU-irina-medium.onnx', 'ru_RU-irina-medium.onnx.json', 'MODEL_CARD')
  },
  @{
    Folder = 'hfc_male'
    BaseUrl = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/hfc_male/medium'
    Files = @('en_US-hfc_male-medium.onnx', 'en_US-hfc_male-medium.onnx.json', 'MODEL_CARD')
  },
  @{
    Folder = 'hfc_female'
    BaseUrl = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/hfc_female/medium'
    Files = @('en_US-hfc_female-medium.onnx', 'en_US-hfc_female-medium.onnx.json', 'MODEL_CARD')
  }
)

foreach ($voice in $voices) {
  $voiceDirectory = Join-Path $PSScriptRoot "..\models\piper-voices\$($voice.Folder)"
  New-Item -ItemType Directory -Force -Path $voiceDirectory | Out-Null

  foreach ($file in $voice.Files) {
    $destination = Join-Path $voiceDirectory $file
    if ((Test-Path $destination) -and -not $Force) {
      Write-Host "Already present: $destination"
      continue
    }

    Write-Host "Downloading $file..."
    $downloadUrl = "$($voice.BaseUrl)/${file}?download=true"
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $destination
  }
}

Write-Host 'Two default Russian and two default English Piper voices are installed.'

# Explicitly reset $LASTEXITCODE so the caller (prepare-release-resources.ps1)
# does not see a stale non-zero exit code from a previous native command when
# every file was already cached and no download actually ran.
$global:LASTEXITCODE = 0
