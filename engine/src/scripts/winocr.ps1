<#
  winocr.ps1 —— Windows 内置 OCR（Windows.Media.Ocr / WinRT）桥接脚本
  ------------------------------------------------------------------
  用途：在零安装、零 token 的前提下对图片做中文/英文 OCR，是漫画与图片艺术字
        汉化的本地快路径。

  调用契约（必须使用 Windows PowerShell 5.1，pwsh 未安装）：
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File winocr.ps1 -In <in.json> -Out <out.json>

  in.json (UTF-8)：
    { "images": [ { "path": "C:\\...\\p1.png", "lang": "zh-Hans-CN" } ],
      "langs": ["zh-Hans-CN","en-US"], "maxDim": 4000 }

  out.json (UTF-8, 无 BOM)：
    { "ok": true, "availableLangs": [...], "maxImageDimension": 10000,
      "results": [ { "path": ..., "ok": true, "lang": ..., "width": ..., "height": ...,
                     "text": ..., "lines": [ { "text": ..., "words": [ {text,x,y,w,h} ] } ] } ] }

  每条结果额外带两个诊断字段（不影响上面的契约字段）：
    * langRequested：本条命中的语言标签；走用户配置语言兜底时为 "<user-profile>"。
    * scale：本条实际缩放系数（1 表示未缩放）；words 的 x/y/w/h 一律是【原图坐标】。

  约定：
    * out.json 始终写出（成功/失败都写）；退出码 0 表示 out.json 已写出。
    * 单张图失败不影响其它图片，整体仍 ok:true。
    * 顶层严重失败（入参解析失败 / 无任何 OCR 引擎）→ { "ok": false, "error": "..." }。
    * 批量：一次进程内处理所有图片，不每张图重启 PowerShell。

  注意：本文件必须保存为 UTF-8 with BOM。PowerShell 5.1 读取无 BOM 的 .ps1 时
        会按系统 ANSI 代码页解码，导致中文注释/字符串乱码甚至语法错误。
#>
param(
  [string]$In,
  [string]$Out
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
# 屏蔽 WinRT/类型加载可能产生的控制台噪声（进度条、警告等一律不进 out.json）
$null = [Console]::OutputEncoding

$script:OutPath = $Out

# ---------------------------------------------------------------------------
# 输出：始终以无 BOM 的 UTF-8 写出 out.json
# ---------------------------------------------------------------------------
function Write-OutJson {
  param([hashtable]$Payload)
  if ([string]::IsNullOrWhiteSpace($script:OutPath)) { return $false }
  try {
    $full = [System.IO.Path]::GetFullPath($script:OutPath)
    $dir = [System.IO.Path]::GetDirectoryName($full)
    if ($dir -and -not [System.IO.Directory]::Exists($dir)) {
      $null = [System.IO.Directory]::CreateDirectory($dir)
    }
    # PS 5.1 的 ConvertTo-Json 默认不转义非 ASCII，中文原样输出
    $json = $Payload | ConvertTo-Json -Depth 16 -Compress
    $enc = New-Object System.Text.UTF8Encoding($false)   # $false = 不写 BOM
    [System.IO.File]::WriteAllText($full, $json, $enc)
    return $true
  } catch {
    # 兜底：至少尝试用 Set-Content（PS5.1 会带 BOM，但 JSON 仍合法）
    try { $Payload | ConvertTo-Json -Depth 16 -Compress | Set-Content -LiteralPath $script:OutPath -Encoding UTF8; return $true } catch { return $false }
  }
}

function Exit-WithFatal {
  param([string]$Message)
  $null = Write-OutJson @{ ok = $false; error = $Message }
  exit 0
}

# ---------------------------------------------------------------------------
# WinRT 异步 → .NET Task 的 Await 辅助（原型同款写法，增强异常解包）
# ---------------------------------------------------------------------------
$script:AsTaskGeneric = $null

function Initialize-WinRt {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  if (-not $script:AsTaskGeneric) { throw '找不到 AsTask(IAsyncOperation<T>) 泛型方法，无法桥接 WinRT 异步调用' }

  # 预加载本脚本用到的 WinRT 类型（ContentType=WindowsRuntime）
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapInterpolationMode, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
}

function Await {
  param($WinRtTask, [Type]$ResultType)
  $asTask = $script:AsTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  try {
    $netTask.Wait(-1) | Out-Null
  } catch {
    # Wait() 会把真实异常包进 AggregateException，PowerShell 又包了一层
    # MethodInvocationException，这里逐层解包，保证错误信息可读（例如"文件损坏"）
    $ex = $_.Exception
    while ($ex.InnerException -and (
        $ex -is [System.AggregateException] -or
        $ex -is [System.Management.Automation.MethodInvocationException] -or
        $ex -is [System.Reflection.TargetInvocationException])) {
      $ex = $ex.InnerException
    }
    throw $ex
  }
  return $netTask.Result
}

# ---------------------------------------------------------------------------
# 语言 / 引擎
# ---------------------------------------------------------------------------
$script:EngineCache = @{}

# 用一个 BCP-47 标签构造 OcrEngine；不可用（本机无该语言识别器）时返回 $null。
#
# 关于 en-US 的踩坑结论（已实测）：New-Object 与 [Language]::new() 都能正确构造出
# tag='en-US' 的 Language，TryCreateFromLanguage 也确实返回 en-US 引擎。
# 之前观察到“传 en-US 却得到 zh-Hans-CN”，真因是 Language 构造那一步抛异常后被
# catch 吞掉，代码继续走到 TryCreateFromUserProfileLanguages()（本机用户配置语言为
# zh-Hans-CN），于是报告成了 zh-Hans-CN。因此这里绝不吞异常后静默回退：
# 构造失败会走静态 new() 重试，两者都失败才算“该语言不可用”，并且由调用方明确
# 决定是否使用用户配置语言兜底。
function New-OcrEngineForTag {
  param([string]$Tag)
  if ([string]::IsNullOrWhiteSpace($Tag)) { return $null }
  $tag = $Tag.Trim()
  $language = $null
  try { $language = New-Object Windows.Globalization.Language $tag } catch { $language = $null }
  if (-not $language) {
    try { $language = [Windows.Globalization.Language]::new($tag) } catch { $language = $null }
  }
  if (-not $language) { return $null }
  try { return [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language) } catch { return $null }
}

function Get-OcrEngineForTag {
  param([string]$Tag)
  if ([string]::IsNullOrWhiteSpace($Tag)) { return $null }
  $key = $Tag.Trim()
  if ($script:EngineCache.ContainsKey($key)) { return $script:EngineCache[$key] }
  $engine = New-OcrEngineForTag $key
  $script:EngineCache[$key] = $engine
  return $engine
}

function Get-UserProfileEngine {
  if (-not $script:EngineCache.ContainsKey('__user_profile__')) {
    $e = $null
    try { $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $e = $null }
    $script:EngineCache['__user_profile__'] = $e
  }
  return $script:EngineCache['__user_profile__']
}

# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
function Clamp-Int {
  param([double]$Value, [int]$Min, [int]$Max)
  $v = [int][Math]::Round($Value)
  if ($v -lt $Min) { return $Min }
  if ($v -gt $Max) { return $Max }
  return $v
}

function New-BitmapTransform {
  param([int]$Width, [int]$Height)
  $t = $null
  try { $t = New-Object Windows.Graphics.Imaging.BitmapTransform } catch { $t = $null }
  if (-not $t) { $t = [Windows.Graphics.Imaging.BitmapTransform]::new() }
  $t.ScaledWidth = [uint32]$Width
  $t.ScaledHeight = [uint32]$Height
  try { $t.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant } catch { }
  return $t
}

# ---------------------------------------------------------------------------
# 单图 OCR
# ---------------------------------------------------------------------------
function Invoke-OcrOnImage {
  param(
    [string]$ImagePath,
    [string[]]$LangChain,
    [int]$MaxDim,
    [int]$HardLimit
  )

  $displayPath = $ImagePath
  $requested = if ($LangChain -and $LangChain.Count -gt 0) { $LangChain[0] } else { '' }

  if ([string]::IsNullOrWhiteSpace($ImagePath)) {
    return @{ path = $displayPath; ok = $false; langRequested = $requested; error = '图像路径为空' }
  }

  $fullPath = $ImagePath
  try { $fullPath = [System.IO.Path]::GetFullPath($ImagePath) } catch { }
  if (-not [System.IO.File]::Exists($fullPath)) {
    return @{ path = $displayPath; ok = $false; langRequested = $requested; error = "图像文件不存在或不可读: $ImagePath" }
  }

  # 候选引擎链：images[i].lang → langs[]（已去重），逐个尝试
  $candidates = @()
  foreach ($tag in $LangChain) {
    if ([string]::IsNullOrWhiteSpace($tag)) { continue }
    $engine = Get-OcrEngineForTag $tag
    if ($engine) { $candidates += @{ tag = $tag.Trim(); engine = $engine } }
  }

  $stream = $null
  $bitmap = $null
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

    $origW = [int]$decoder.PixelWidth
    $origH = [int]$decoder.PixelHeight

    # 有效上限 = min(maxDim, OcrEngine.MaxImageDimension)，保证不超过硬上限
    $cap = $MaxDim
    if ($cap -le 0) { $cap = 4000 }
    if ($HardLimit -gt 0 -and $cap -gt $HardLimit) { $cap = $HardLimit }

    $longest = [Math]::Max($origW, $origH)
    $scale = 1.0
    if ($longest -gt $cap -and $longest -gt 0) { $scale = [double]$cap / [double]$longest }
    $targetW = [int][Math]::Max(1, [Math]::Round($origW * $scale))
    $targetH = [int][Math]::Max(1, [Math]::Round($origH * $scale))

    # 解码为 Bgra8/Premultiplied（RecognizeAsync 对像素格式敏感；
    # 非 Bgra8 一律 SoftwareBitmap.Convert）
    if ($scale -lt 1.0) {
      $transform = New-BitmapTransform -Width $targetW -Height $targetH
      try {
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
          [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
          [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
          $transform,
          [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
          [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
      } catch {
        # 个别解码器不支持 5 参重载时退回默认解码（后面统一做像素格式转换）
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      }
    } else {
      try {
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
          [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
          [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
      } catch {
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      }
    }

    if ($bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8) {
      $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert(
        $bitmap,
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
      $bitmap.Dispose()
      $bitmap = $converted
    }

    # 逐候选语言识别
    $ocrResult = $null
    $usedTag = $null
    $usedEngine = $null
    $attemptErrors = @()
    foreach ($cand in $candidates) {
      try {
        $ocrResult = Await ($cand.engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $usedTag = $cand.tag
        $usedEngine = $cand.engine
        break
      } catch {
        $attemptErrors += ("{0}: {1}" -f $cand.tag, $_.Exception.Message)
        $ocrResult = $null
      }
    }

    # 全部候选失败 → 用户配置语言兜底
    if (-not $ocrResult) {
      $fallback = Get-UserProfileEngine
      if ($fallback) {
        try {
          $ocrResult = Await ($fallback.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
          $usedTag = '<user-profile>'
          $usedEngine = $fallback
        } catch {
          $attemptErrors += ("<user-profile>: {0}" -f $_.Exception.Message)
          $ocrResult = $null
        }
      }
    }

    if (-not $ocrResult) {
      $msg = if ($attemptErrors.Count -gt 0) { '所有候选语言均识别失败 -> ' + ($attemptErrors -join ' | ') } else { '没有可用于该图像的 OCR 引擎（请求语言均不可用）' }
      return @{ path = $displayPath; ok = $false; langRequested = $requested; width = $origW; height = $origH; error = $msg }
    }

    # 坐标换算回原图：识别在缩放图上进行，除以 scale 即得原图坐标
    $inv = if ($scale -gt 0) { 1.0 / $scale } else { 1.0 }
    $lines = @()
    foreach ($line in $ocrResult.Lines) {
      $words = @()
      foreach ($word in $line.Words) {
        $rect = $word.BoundingRect
        $x = Clamp-Int ($rect.X * $inv) 0 $origW
        $y = Clamp-Int ($rect.Y * $inv) 0 $origH
        $w = Clamp-Int ($rect.Width * $inv) 0 ($origW - $x)
        $h = Clamp-Int ($rect.Height * $inv) 0 ($origH - $y)
        $words += @{ text = $word.Text; x = $x; y = $y; w = $w; h = $h }
      }
      $lines += @{ text = $line.Text; words = $words }
    }

    $text = ($lines | ForEach-Object { $_.text }) -join "`n"

    return @{
      path          = $displayPath
      ok            = $true
      lang          = $usedEngine.RecognizerLanguage.LanguageTag   # 实际使用的识别语言
      langRequested = $usedTag
      width         = $origW
      height        = $origH
      scale         = [Math]::Round($scale, 6)
      text          = $text
      lines         = $lines
    }
  } catch {
    return @{ path = $displayPath; ok = $false; langRequested = $requested; error = ('图像处理失败: ' + $_.Exception.Message) }
  } finally {
    if ($bitmap) { try { $bitmap.Dispose() } catch { } }
    if ($stream) { try { $stream.Dispose() } catch { } }
  }
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
$script:AvailableLangs = @()
$script:MaxImageDim = 0

try {
  Initialize-WinRt
} catch {
  Exit-WithFatal ('WinRT 初始化失败（本机可能不支持 Windows.Media.Ocr）: ' + $_.Exception.Message)
}

try {
  $script:AvailableLangs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
} catch {
  $script:AvailableLangs = @()
}
try { $script:MaxImageDim = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension } catch { $script:MaxImageDim = 0 }

if ([string]::IsNullOrWhiteSpace($In)) { Exit-WithFatal '缺少 -In 入参（输入 JSON 路径）' }
if ([string]::IsNullOrWhiteSpace($Out)) { exit 1 }

# ---- 解析入参 ----
$inputObject = $null
try {
  $inFull = [System.IO.Path]::GetFullPath($In)
  if (-not [System.IO.File]::Exists($inFull)) { Exit-WithFatal "入参文件不存在: $In" }
  $rawText = [System.IO.File]::ReadAllText($inFull, (New-Object System.Text.UTF8Encoding($false)))
  if ($rawText.Length -gt 0 -and $rawText[0] -eq [char]0xFEFF) { $rawText = $rawText.Substring(1) }
  $inputObject = $rawText | ConvertFrom-Json
} catch {
  Exit-WithFatal ('解析入参 JSON 失败: ' + $_.Exception.Message)
}

$images = @()
if ($inputObject -and $inputObject.PSObject.Properties['images'] -and $inputObject.images) {
  $images = @($inputObject.images)
}
if ($images.Count -eq 0) { Exit-WithFatal '入参 JSON 中没有 images 数组或数组为空' }

# ---- 语言回退链 ----
$globalLangs = @()
if ($inputObject.PSObject.Properties['langs'] -and $inputObject.langs) { $globalLangs = @($inputObject.langs | ForEach-Object { "$_" }) }

# ---- 缩放上限 ----
$maxDim = 4000
if ($inputObject.PSObject.Properties['maxDim'] -and $null -ne $inputObject.maxDim) {
  try { $maxDim = [int]$inputObject.maxDim } catch { $maxDim = 4000 }
}
if ($maxDim -le 0) { $maxDim = 4000 }

# ---- 顶层：本机是否根本没有 OCR 引擎 ----
$userProfileEngine = Get-UserProfileEngine
if ($script:AvailableLangs.Count -eq 0 -and -not $userProfileEngine) {
  Exit-WithFatal '本机没有任何可用的 Windows OCR 识别语言（AvailableRecognizerLanguages 为空且用户配置语言不可用）'
}

# ---- 批量处理（单进程内循环，避免每张图重启 PowerShell） ----
$results = @()
foreach ($img in $images) {
  $imgPath = ''
  $imgLang = ''
  if ($img -is [string]) {
    $imgPath = "$img"
  } else {
    if ($img.PSObject.Properties['path'] -and $null -ne $img.path) { $imgPath = "$($img.path)" }
    if ($img.PSObject.Properties['lang'] -and $null -ne $img.lang) { $imgLang = "$($img.lang)" }
  }

  # 回退链：本图 lang → 全局 langs（按顺序、去重）
  $chain = New-Object System.Collections.ArrayList
  foreach ($t in @($imgLang) + @($globalLangs)) {
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    $tt = "$t".Trim()
    if (-not $chain.Contains($tt)) { $null = $chain.Add($tt) }
  }

  $results += (Invoke-OcrOnImage -ImagePath $imgPath -LangChain @($chain) -MaxDim $maxDim -HardLimit $script:MaxImageDim)
}

# ---- 汇总输出 ----
$ok = Write-OutJson @{
  ok                = $true
  availableLangs    = @($script:AvailableLangs)
  maxImageDimension = $script:MaxImageDim
  results           = @($results)
}
if (-not $ok) { exit 1 }
exit 0
