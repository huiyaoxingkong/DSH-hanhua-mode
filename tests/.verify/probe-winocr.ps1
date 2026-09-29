# 探测 Windows.Media.Ocr（WinRT）在本机是否可用（Windows PowerShell 5.1）
$ErrorActionPreference = 'Continue'
try {
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  Write-Host "TYPE_OK"
} catch { Write-Host "TYPE_FAIL: $($_.Exception.Message)"; exit 1 }

try {
  $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
  Write-Host ("LANGS=" + ($langs | ForEach-Object { $_.LanguageTag }) -join ',')
} catch { Write-Host "LANGS_FAIL: $($_.Exception.Message)" }

try {
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  Write-Host "MAXDIM=$max"
} catch { Write-Host "MAXDIM_FAIL: $($_.Exception.Message)" }

# 尝试为 zh-Hans 创建引擎
try {
  $lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'
  $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  Write-Host "ZH_ENGINE=" + ($(if ($eng) { 'OK' } else { 'NULL' }))
} catch { Write-Host "ZH_ENGINE_FAIL: $($_.Exception.Message)" }

try {
  $eng2 = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  Write-Host "PROFILE_ENGINE=" + ($(if ($eng2) { 'OK lang=' + $eng2.RecognizerLanguage.LanguageTag } else { 'NULL' }))
} catch { Write-Host "PROFILE_ENGINE_FAIL: $($_.Exception.Message)" }
