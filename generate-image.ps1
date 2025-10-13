# === generate-image.ps1 ===
# Generación de imagen con Vertex AI (Imagen 3 y 4)
# Requisitos: gcloud instalado y autenticado (ADC), proyecto y región configurados.

param(
  [string]$Prompt,
  [string]$AspectRatio = "16:9",                 # 1:1, 3:2, 4:5, 16:9...
  [ValidateSet("imagen-4.0-generate-001","imagen-4.0-ultra-generate-001","imagen-4.0-fast-generate-001","imagen-4.0-generate-preview-06-06","imagen-4.0-ultra-generate-preview-06-06","imagen-4.0-fast-generate-preview-06-06","imagen-4.0-generate-preview-05-20","imagen-4.0-ultra-generate-preview-05-20","imagen-4.0-fast-generate-preview-05-20","imagen-3.0-generate-002","imagen-3.0-generate-001","imagen-3.0-fast-generate-001","imagegeneration@006","imagegeneration@005","imagegeneration@002")]
  [string]$Model = "imagen-4.0-generate-001",    # Modelos Imagen 4/3/2 GA y preview disponibles en Vertex AI
  [string]$Out = "",
  [int]$SampleCount = 1,
  [bool]$EnhancePrompt = $true
)

$PROJECT_ID = "generador-474400"
$LOCATION   = "us-central1"

if (-not $Prompt -or $Prompt.Trim().Length -eq 0) {
  $Prompt = Read-Host "Escribe el PROMPT (ej: 'Foto realista de casa moderna con techo de teja española al atardecer')"
}

if (-not $Out -or $Out.Trim().Length -eq 0) {
  $stamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
  $Out   = "img_${stamp}.png"
}

if ($SampleCount -lt 1 -or $SampleCount -gt 4) {
  Write-Error "SampleCount debe estar entre 1 y 4."
  exit 5
}

Write-Host "Obteniendo token..." -ForegroundColor Cyan
$TOKEN = (gcloud auth application-default print-access-token)
if (-not $TOKEN) {
  Write-Error "No se pudo obtener el token de acceso. Verifica 'gcloud auth application-default login'."
  exit 1
}

Write-Host "Solicitando imagen a Vertex AI..." -ForegroundColor Cyan

# Cuerpo de la solicitud
$parameters = @{
  sampleCount      = $SampleCount
  language         = "es"
  aspectRatio      = $AspectRatio
  personGeneration = "allow_adult"
  outputOptions    = @{
    mimeType           = "image/png"
    compressionQuality = 90
  }
}
if ($Model -like "imagen-4*") {
  $parameters.enhancePrompt = $EnhancePrompt
}

$BODY = @{
  instances = @(
    @{
      prompt = $Prompt
    }
  )
  parameters = $parameters
} | ConvertTo-Json -Depth 6

$URL = "https://$LOCATION-aiplatform.googleapis.com/v1/projects/$PROJECT_ID/locations/$LOCATION/publishers/google/models/$Model:predict"

try {
  $headers = @{ Authorization = "Bearer $TOKEN"; "Content-Type" = "application/json" }
  $resp    = Invoke-RestMethod -Uri $URL -Method POST -Headers $headers -Body $BODY

  if (-not $resp.predictions -or $resp.predictions.Count -eq 0) {
    Write-Host "Sin 'predictions'. Respuesta completa:" -ForegroundColor Yellow
    $resp | ConvertTo-Json -Depth 10
    exit 2
  }

  if ($resp.predictions.Count -ne $SampleCount) {
    Write-Host "⚠️ Conteo de predicciones inesperado: $($resp.predictions.Count) (esperado $SampleCount)" -ForegroundColor Yellow
  }

  $saveTargets = @()

  for ($i = 0; $i -lt [Math]::Min($resp.predictions.Count, $SampleCount); $i++) {
    $b64 = $resp.predictions[$i].bytesBase64Encoded
    if (-not $b64) { $b64 = $resp.predictions[$i].byteBase64Encoded }
    if (-not $b64) { $b64 = $resp.predictions[$i].imageBytes }

    if (-not $b64) {
      Write-Host "No se encontró el campo base64 en predictions[$i]." -ForegroundColor Yellow
      continue
    }

    if ($SampleCount -eq 1) {
      $targetPath = $Out
    }
    else {
      $dir  = [IO.Path]::GetDirectoryName($Out)
      if ([string]::IsNullOrWhiteSpace($dir)) { $dir = (Get-Location).Path }
      $name = [IO.Path]::GetFileNameWithoutExtension($Out)
      if ([string]::IsNullOrWhiteSpace($name)) { $name = "img_$((Get-Date).ToString('yyyyMMdd_HHmmss'))" }
      $ext  = [IO.Path]::GetExtension($Out)
      if ([string]::IsNullOrWhiteSpace($ext)) { $ext = ".png" }
      $targetPath = Join-Path $dir ("{0}_{1:D2}{2}" -f $name, $i + 1, $ext)
    }

    [IO.File]::WriteAllBytes($targetPath, [Convert]::FromBase64String($b64))
    $saveTargets += $targetPath
    Write-Host "✅ Imagen guardada: $targetPath" -ForegroundColor Green
  }

  if ($saveTargets.Count -eq 0) {
    exit 3
  }

  Write-Host "   Prompt: $Prompt"
  Write-Host "   Modelo: $Model | AR: $AspectRatio | Cantidad: $SampleCount"
}
catch {
  Write-Host "❌ Error en la solicitud: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ErrorDetails) { Write-Host ($_.ErrorDetails | Out-String) }
  Write-Host "`nRevisa:" -ForegroundColor Yellow
  Write-Host " - API habilitada:  gcloud services enable aiplatform.googleapis.com --project $PROJECT_ID"
  Write-Host " - Permisos: cuenta con rol 'Vertex AI User'."
  exit 4
}
