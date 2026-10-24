# -*- coding: utf-8 -*-
<#
.SYNOPSIS
    在 D 盘搭起本机 ControlNet 环境（Python 3.12 + CUDA 版 PyTorch + diffusers）。

.DESCRIPTION
    为什么这么装（都是实测踩出来的）：
      * 用户机器上的 Python 3.15 装不了 PyTorch —— PyTorch 官方只出到 cp314，
        `cp315` 的 Windows 轮子是 0 个。所以单独装一个 Python 3.12，不碰现有的 3.14/3.15。
      * 显卡是 RTX 5060 Laptop，compute_cap 12.0（sm_120，Blackwell），必须 cu128。
      * download.pytorch.org 实测只有 180 KB/s（2.5 GB 要下 4 小时），
        上交大镜像实测 15.7 MB/s，差 87 倍，所以走 https://mirror.sjtu.edu.cn/pytorch-wheels/cu128。
      * 普通 Python 包走清华 PyPI 镜像，实测 38.7 MB/s。
      * 所有缓存（pip / HF / torch）都指到 D 盘，C 盘只有 97 GB 且已用掉大半。
      * 注意 D:\ai 是 DSH 自带的 Node.js 运行环境，ACL 受保护写不进去，所以根目录用 D:\citysim。

.USAGE
    pwsh -File D:\Users\asus\Desktop\项目\tools\setup_ai_env.ps1
#>
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$root   = 'D:\citysim'
$py     = "$root\python312\python.exe"
$venv   = "$root\venv"
$vpy    = "$venv\Scripts\python.exe"
$PIPI   = 'https://pypi.tuna.tsinghua.edu.cn/simple'
$TORCHI = 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu128'

# 缓存全放 D 盘
$env:PIP_CACHE_DIR = "$root\cache\pip"
$env:HF_HOME      = "$root\cache\hf"
$env:TORCH_HOME   = "$root\cache\torch"
$env:TMP          = "$root\cache\tmp"
$env:TEMP         = "$root\cache\tmp"
New-Item -ItemType Directory -Force -Path $env:PIP_CACHE_DIR, $env:HF_HOME, $env:TORCH_HOME, $env:TMP | Out-Null

if (-not (Test-Path $py)) { Write-Output "找不到 $py，先用 tools 里的安装步骤装 Python 3.12"; exit 1 }

if (-not (Test-Path $vpy)) {
    & $py -m venv $venv
    Write-Output "venv 建好：$venv"
}

& $vpy -m pip install -U pip setuptools wheel -i $PIPI 2>&1 | Select-Object -Last 3

# 从上交大镜像里挑 cp312 + win_amd64 的轮子；prefer 为指定版本，找不到就退回最高版本。
# 两个坑：① 索引里的 href 是相对路径（/pytorch-wheels/...），必须补主机名；
#         ② href 结尾带 #sha256=...，所以正则绝不能要求它以 .whl" 收尾（第一版就栽在这里）。
function Pick-Wheel([string]$pkg, [string]$prefer) {
    $h = ((& curl.exe -s --max-time 90 -L "$TORCHI/$pkg/") -join "`n")
    $cand = @([regex]::Matches($h, 'href="([^"]+\.whl)') | ForEach-Object { $_.Groups[1].Value } |
              Where-Object { $_ -match 'cp312' -and $_ -match 'win_amd64' })
    Write-Host ("  [$pkg] candidates: " + $cand.Count)
    $fallback = $null; $fv = $null
    foreach ($x in $cand) {
        $f = (($x -split '/')[-1] -replace '#.*$', '')
        if ($f -notmatch ('^' + [regex]::Escape($pkg) + '-([0-9]+\.[0-9]+\.[0-9]+)(%2B|\+)cu128-cp312')) { continue }
        $ver = $Matches[1]
        $abs = if ($x -match '^https?://') { $x } else { 'https://mirror.sjtu.edu.cn' + $x }
        if ($prefer -and $ver -eq $prefer) { return $abs }
        $vv = [version]$ver
        if ($null -eq $fv -or $vv -gt $fv) { $fv = $vv; $fallback = $abs }
    }
    return $fallback
}

Write-Output '--- 装 PyTorch (cu128, 来自上交大镜像) ---'
# 上一轮被清华镜像顺手塞了个 CPU 版 torch (2.14.1+cpu) 进来，必须先卸干净
& $vpy -m pip uninstall -y torch torchvision torchaudio 2>&1 | Select-Object -Last 2

# 实测配对：torch 2.10.0+cu128 <-> torchvision 0.25.0+cu128
$tw = Pick-Wheel 'torch' '2.10.0'
if ($tw) { Write-Output ("  torch 轮子: " + (($tw -split '/')[-1] -replace '#.*$', '')) } else { Write-Output '  ✗ 没在上交大镜像里找到 torch 的 cp312/win 轮子'; exit 1 }
& $vpy -m pip install $tw -i $PIPI 2>&1 | Select-Object -Last 4
& $vpy -c "import torch;print('  torch 实际版本:', torch.__version__)"

$vw = Pick-Wheel 'torchvision' '0.25.0'
if ($vw) { Write-Output ("  torchvision 轮子: " + (($vw -split '/')[-1] -replace '#.*$', '')) } else { Write-Output '  ! 没找到 torchvision 轮子，跳过（ControlNet 不强依赖它）' }
if ($vw) { & $vpy -m pip install $vw -i $PIPI 2>&1 | Select-Object -Last 4 }

Write-Output '--- 装扩散模型生态 ---'
& $vpy -m pip install diffusers transformers accelerate safetensors huggingface_hub pillow numpy scipy -i $PIPI 2>&1 | Select-Object -Last 5

Write-Output '--- 验证 ---'
& $vpy -c "import torch; print('torch', torch.__version__); print('cuda available', torch.cuda.is_available()); print('device', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A'); print('capability', torch.cuda.get_device_capability(0) if torch.cuda.is_available() else 'N/A')"
& $vpy -c "import diffusers, transformers; print('diffusers', diffusers.__version__); print('transformers', transformers.__version__)"
