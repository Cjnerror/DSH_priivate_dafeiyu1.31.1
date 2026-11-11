# 文字转语音（Windows SAPI）—— 由桥接以子进程方式调用，不是给人直接跑的。
#
# 为什么用文件传文本而不是命令行参数：
#   命令行里的中文要经过控制台代码页（本机 GBK）往返，PowerShell 5.1 用 -File 启动时
#   又按系统 ANSI 页解读无 BOM 的脚本；两处任意一处错位，中文都会变成乱码或问号。
#   文本一律走 UTF-8 文件（TextFile），脚本自身也不含中文以外的变量插值。
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Voice = '',
  [int]$Rate = 0,
  [int]$Volume = 100
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Speech
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.UTF8Encoding]::new($false))
  $text = $text.Trim()
  if (-not $text) { Write-Error 'text-empty'; exit 2 }
  if ($text.Length -gt 2000) { $text = $text.Substring(0, 2000) }

  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  if ($Voice) {
    try { $synth.SelectVoice($Voice) } catch { }
  }
  # Rate 范围 -10(最慢) ~ 10(最快)；Volume 0~100。
  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))

  $dir = [System.IO.Path]::GetDirectoryName($OutFile)
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

  $synth.SetOutputToWaveFile($OutFile)
  $synth.Speak($text)
  $synth.Dispose()

  if (-not (Test-Path $OutFile)) { Write-Error 'no-output'; exit 3 }
  $size = (Get-Item $OutFile).Length
  if ($size -le 44) { Write-Error 'empty-wav'; exit 4 }

  Write-Output "ok $size"
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
