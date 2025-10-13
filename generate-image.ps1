# === generate-image.ps1 ===
# Generación de imagen con Vertex AI (Imagen 3)
# Requisitos: gcloud instalado y autenticado (ADC), proyecto y región configurados.

param(
  [string]$Prompt,
  [string]$AspectRatio = "16:9",                 # 1:1, 3:2, 4:5, 16:9...
  [string]$Model = "imagen-3.0-generate-002",    # puedes probar imagen-4.0-generate-001 si lo tienes
  [string]$Out = ""                              # si vacío, se genera nombre automático
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

Write-Host "Obteniendo token..." -ForegroundColor Cyan
$TOKEN = (gcloud auth application-default print-access-token)
if (-not $TOKEN) {
  Write-Error "No se pudo obtener el token de acceso. Verifica 'gcloud auth application-default login'."
  exit 1
}

Write-Host "Solicitando imagen a Vertex AI..." -ForegroundColor Cyan

# Cuerpo de la solicitud
$BODY = @{
  instances = @(
    @{
      prompt = $Prompt
    }
  )
  parameters = @{
    sampleCount      = 1
    language         = "es"
    aspectRatio      = $AspectRatio
    personGeneration = "allow_adult"
    outputOptions    = @{
      mimeType           = "image/png"
      compressionQuality = 90
    }
    # Si usas un modelo "fast" y ves deformaciones, prueba:
    # enhancePrompt = $false
  }
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

  # Extraer la imagen (Vertex puede devolver diferentes campos)
  $b64 = $resp.predictions[0].bytesBase64Encoded
  if (-not $b64) { $b64 = $resp.predictions[0].byteBase64Encoded }
  if (-not $b64) { $b64 = $resp.predictions[0].imageBytes }

  if (-not $b64) {
    Write-Host "No se encontró el campo base64 en predictions[0]. Respuesta:" -ForegroundColor Yellow
    $resp | ConvertTo-Json -Depth 10
    exit 3
  }

  [IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($b64))
  Write-Host "✅ Imagen guardada: $Out" -ForegroundColor Green
  Write-Host "   Prompt: $Prompt"
  Write-Host "   Modelo: $Model | AR: $AspectRatio"
}
catch {
  Write-Host "❌ Error en la solicitud: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ErrorDetails) { Write-Host ($_.ErrorDetails | Out-String) }
  Write-Host "`nRevisa:" -ForegroundColor Yellow
  Write-Host " - API habilitada:  gcloud services enable aiplatform.googleapis.com --project $PROJECT_ID"
  Write-Host " - Permisos: cuenta con rol 'Vertex AI User'."
  exit 4
}
