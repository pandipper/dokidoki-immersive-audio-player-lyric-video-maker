# -*- coding: utf-8 -*-
<#
    dokidoki 离线静态服务器

    为什么需要它：
      dokidoki 是 Vite 构建的 ES Module 应用，浏览器不允许用 file:// 直接打开
      （模块脚本受 CORS 限制），而且 FFmpeg WASM 需要 SharedArrayBuffer，
      必须由服务端下发 COOP/COEP 响应头。所以「双击 HTML」这条路走不通，
      需要一个本地 HTTP 服务。

    为什么用 PowerShell 而不是 Node：
      另一台离线电脑不一定装了 Node。Windows 自带 PowerShell + .NET，
      零安装即可运行。
#>
[CmdletBinding()]
param(
    [int]$Port = 3000,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$Root = Join-Path $PSScriptRoot 'app'
if (-not (Test-Path -LiteralPath $Root)) {
    Write-Host "[错误] 找不到 app 目录：$Root" -ForegroundColor Red
    exit 1
}
$Root = (Resolve-Path -LiteralPath $Root).Path

# 常见静态资源后缀 → Content-Type
$MimeMap = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.webmanifest' = 'application/manifest+json; charset=utf-8'
    '.map'  = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.webp' = 'image/webp'
    '.ico'  = 'image/x-icon'
    '.woff' = 'font/woff'
    '.woff2' = 'font/woff2'
    '.ttf'  = 'font/ttf'
    '.otf'  = 'font/otf'
    '.wasm' = 'application/wasm'
    '.mp4'  = 'video/mp4'
    '.webm' = 'video/webm'
    '.mp3'  = 'audio/mpeg'
    '.txt'  = 'text/plain; charset=utf-8'
    '.xml'  = 'application/xml; charset=utf-8'
}

function Test-PortFree {
    param([int]$Candidate)
    try {
        $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Candidate)
        $l.Start()
        $l.Stop()
        return $true
    } catch {
        return $false
    }
}

# 从 3000 起找一个空闲端口
$chosen = 0
for ($p = $Port; $p -lt ($Port + 200); $p++) {
    if (Test-PortFree -Candidate $p) { $chosen = $p; break }
}
if ($chosen -eq 0) {
    Write-Host "[错误] 从 $Port 起连续 200 个端口都被占用，请手动指定：-Port 8080" -ForegroundColor Red
    exit 1
}

$prefix = "http://localhost:$chosen/"
$listener = [System.Net.HttpListener]::new()
# 同时注册 localhost 与 127.0.0.1：HttpListener 按前缀精确匹配主机名，
# 只注册 localhost 的话用 127.0.0.1 访问会返回 400 Invalid Hostname。
$listener.Prefixes.Add($prefix)
$listener.Prefixes.Add("http://127.0.0.1:$chosen/")

try {
    $listener.Start()
} catch {
    Write-Host "[错误] 无法监听 $prefix" -ForegroundColor Red
    Write-Host "        $($_.Exception.Message)" -ForegroundColor DarkGray
    Write-Host "        如果是权限问题，请右键本脚本选择「以管理员身份运行」。" -ForegroundColor DarkGray
    exit 1
}

$url = "http://localhost:$chosen/"
Write-Host ''
Write-Host '  dokidoki 字幕播放器 —— 离线版' -ForegroundColor Yellow
Write-Host "  服务地址：$url" -ForegroundColor Cyan
Write-Host '  关闭窗口或按 Ctrl+C 即可停止。' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoBrowser) {
    try { Start-Process $url | Out-Null } catch { }
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response

        try {
            # COOP/COEP：FFmpeg WASM 的 SharedArrayBuffer 依赖这两个头
            $res.Headers['Cross-Origin-Opener-Policy'] = 'same-origin'
            $res.Headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
            $res.Headers['Cross-Origin-Resource-Policy'] = 'cross-origin'
            $res.Headers['Cache-Control'] = 'no-cache'

            $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
            if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
            $rel = $rel -replace '/', '\'

            $full = Join-Path $Root $rel
            $full = [System.IO.Path]::GetFullPath($full)

            # 防目录穿越
            if (-not $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $res.StatusCode = 403
                $res.Close()
                continue
            }

            # 找不到就回退到 index.html（SPA）
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                $full = Join-Path $Root 'index.html'
            }

            $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
            $ctype = $MimeMap[$ext]
            if (-not $ctype) { $ctype = 'application/octet-stream' }
            $res.ContentType = $ctype

            $bytes = [System.IO.File]::ReadAllBytes($full)
            $res.ContentLength64 = $bytes.Length
            if ($req.HttpMethod -ne 'HEAD') {
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } catch {
            try { $res.StatusCode = 500 } catch { }
        } finally {
            try { $res.Close() } catch { }
        }
    }
} finally {
    try { $listener.Stop(); $listener.Close() } catch { }
}
