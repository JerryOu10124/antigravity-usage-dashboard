param(
    [string]$InstallDir = "",
    [string]$PluginDest = "",
    [string]$DataDir = "",
    [string]$BundleOut = "",
    [switch]$SkipPlugin,
    [switch]$SkipSync,
    [switch]$NoPause
)

$callerScriptDir = $PSScriptRoot

& {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = "Stop"

    $RepoUrl = "https://github.com/JerryOu10124/antigravity-usage-dashboard.git"
    $RepoZipUrl = "https://github.com/JerryOu10124/antigravity-usage-dashboard/archive/refs/heads/main.zip"
    $PortableNodeDir = Join-Path $env:LOCALAPPDATA "antigravity-node"

    function Test-NodeMajor20 {
        param([string]$ExePath)
        if ([string]::IsNullOrWhiteSpace($ExePath) -or -not (Test-Path -LiteralPath $ExePath)) {
            return $false
        }
        try {
            $ver = (& $ExePath -v 2>$null | Select-Object -First 1).Trim()
            if ($ver -match "^v?(\d+)\.") {
                return ([int]$Matches[1] -ge 20)
            }
        } catch {
            return $false
        }
        return $false
    }

    function Find-Node20 {
        $candidates = New-Object 'System.Collections.Generic.List[string]'
        $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source) { [void]$candidates.Add($cmd.Source) }

        $staticList = @(
            (Join-Path $PortableNodeDir "node.exe"),
            "C:\Program Files\nodejs\node.exe",
            "D:\nodejs\node.exe",
            (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
        )
        if ($env:NVM_SYMLINK) { $staticList += (Join-Path $env:NVM_SYMLINK "node.exe") }
        if ($env:USERPROFILE) { $staticList += (Join-Path $env:USERPROFILE "scoop\shims\node.exe") }
        if ($env:LOCALAPPDATA) { $staticList += (Join-Path $env:LOCALAPPDATA "Volta\bin\node.exe") }

        foreach ($p in $staticList) {
            if ($p -and -not $candidates.Contains($p)) {
                [void]$candidates.Add($p)
            }
        }

        foreach ($cand in $candidates) {
            if (Test-NodeMajor20 -ExePath $cand) {
                return $cand
            }
        }
        return $null
    }

    function Refresh-ProcessPath {
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $parts = @($machinePath, $userPath, $env:Path) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        $env:Path = ($parts -join ";")
    }

    function Enable-Tls12 {
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        } catch {
            # Ignore on newer .NET runtimes
        }
    }

    function Install-PortableNode {
        Enable-Tls12
        Write-Host "[Setup] Fetching latest Node.js LTS metadata from nodejs.org..."
        $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing -TimeoutSec 30
        $lts = $index | Where-Object { $_.lts -and ($_.version -match "^v(\d+)\.") -and ([int]$Matches[1] -ge 20) } | Select-Object -First 1
        if (-not $lts) {
            throw "Failed to resolve Node.js 20+ LTS release from nodejs.org."
        }

        $ver = $lts.version
        $rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        $arch = if ($rawArch -match "ARM64") { "arm64" } else { "x64" }
        $zipName = "node-$ver-win-$arch.zip"
        $zipUrl = "https://nodejs.org/dist/$ver/$zipName"
        $tmpZip = Join-Path $env:TEMP ("agy-" + $zipName)
        $tmpExtract = Join-Path $env:TEMP ("agy-node-ext-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))

        try {
            Write-Host "[Setup] Downloading portable Node.js $ver ($arch)..."
            Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing -TimeoutSec 180
            Write-Host "[Setup] Extracting portable Node.js to $PortableNodeDir ..."
            Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpExtract -Force

            $innerDir = Get-ChildItem -LiteralPath $tmpExtract -Directory | Select-Object -First 1
            $innerExe = if ($innerDir) { Join-Path $innerDir.FullName "node.exe" } else { "" }
            if (-not (Test-NodeMajor20 -ExePath $innerExe)) {
                throw "Extracted portable Node.js binary failed verification."
            }

            $oldDir = "$PortableNodeDir.old." + [Guid]::NewGuid().ToString("N").Substring(0, 6)
            if (Test-Path -LiteralPath $PortableNodeDir) {
                Move-Item -LiteralPath $PortableNodeDir -Destination $oldDir -Force
            }
            try {
                Move-Item -LiteralPath $innerDir.FullName -Destination $PortableNodeDir -Force
                if (Test-Path -LiteralPath $oldDir) {
                    Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue
                }
            } catch {
                if ((Test-Path -LiteralPath $oldDir) -and -not (Test-Path -LiteralPath $PortableNodeDir)) {
                    Move-Item -LiteralPath $oldDir -Destination $PortableNodeDir -Force
                }
                throw
            }
        } finally {
            if (Test-Path -LiteralPath $tmpZip) { Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $tmpExtract) { Remove-Item -LiteralPath $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue }
        }

        $exe = Join-Path $PortableNodeDir "node.exe"
        if (-not (Test-NodeMajor20 -ExePath $exe)) {
            throw "Portable Node.js installation verification failed."
        }
        return $exe
    }

    function Ensure-Node20 {
        $found = Find-Node20
        if ($found) {
            $v = (& $found -v 2>$null | Select-Object -First 1).Trim()
            Write-Host "[Setup] Found Node.js $v ($found)"
            return $found
        }

        Write-Host "[Setup] Node.js 20+ not found. Attempting automatic installation..."
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Host "[Setup] Trying winget install OpenJS.NodeJS.LTS ..."
            try {
                & $winget.Source install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements --silent | Out-Host
                Refresh-ProcessPath
                $found = Find-Node20
                if ($found) {
                    $v = (& $found -v 2>$null | Select-Object -First 1).Trim()
                    Write-Host "[Setup] Installed Node.js $v via winget ($found)"
                    return $found
                }
            } catch {
                Write-Host "[Setup] winget install skipped or failed, falling back to portable Node.js..."
            }
        }

        try {
            $found = Install-PortableNode
            $v = (& $found -v 2>$null | Select-Object -First 1).Trim()
            Write-Host "[Setup] Installed portable Node.js $v ($found)"
            return $found
        } catch {
            throw ("Could not install Node.js 20+ automatically. Please install Node.js LTS manually from https://nodejs.org/ and re-run setup. Details: " + $_.Exception.Message)
        }
    }

    function Copy-TreePreservingData {
        param([string]$SrcDir, [string]$DestDir)
        New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
        $items = Get-ChildItem -LiteralPath $SrcDir -Force
        foreach ($item in $items) {
            if ($item.Name -eq ".git") { continue }
            $targetPath = Join-Path $DestDir $item.Name
            if ($item.PSIsContainer) {
                if ($item.Name -eq "data") {
                    New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
                    $keepFile = Join-Path $item.FullName ".gitkeep"
                    if ((Test-Path -LiteralPath $keepFile) -and -not (Test-Path -LiteralPath (Join-Path $targetPath ".gitkeep"))) {
                        Copy-Item -LiteralPath $keepFile -Destination (Join-Path $targetPath ".gitkeep") -Force
                    }
                    continue
                }
                Copy-TreePreservingData -SrcDir $item.FullName -DestDir $targetPath
            } else {
                if ($item.Name -eq "config.json" -and (Test-Path -LiteralPath $targetPath)) {
                    continue
                }
                Copy-Item -LiteralPath $item.FullName -Destination $targetPath -Force
            }
        }
    }

    function Resolve-RepoDir {
        $localRoot = ""
        if (-not [string]::IsNullOrWhiteSpace($callerScriptDir)) {
            $candidate = Split-Path -Path $callerScriptDir -Parent
            if (
                (Test-Path -LiteralPath (Join-Path $candidate "install.mjs")) -and
                (Test-Path -LiteralPath (Join-Path $candidate "plugin\token-usage\dist\server.cjs"))
            ) {
                $localRoot = $candidate
            }
        }
        if ($localRoot) {
            return $localRoot
        }

        $target = if (-not [string]::IsNullOrWhiteSpace($InstallDir)) {
            [System.IO.Path]::GetFullPath($InstallDir)
        } elseif (-not [string]::IsNullOrWhiteSpace($env:AGY_DASHBOARD_DIR)) {
            [System.IO.Path]::GetFullPath($env:AGY_DASHBOARD_DIR)
        } else {
            Join-Path $env:USERPROFILE "antigravity-usage-dashboard"
        }

        $gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
        if ($gitCmd) {
            if (Test-Path -LiteralPath (Join-Path $target ".git")) {
                $originUrl = (& $gitCmd.Source -C $target remote get-url origin 2>$null | Select-Object -First 1)
                if (
                    -not (Test-Path -LiteralPath (Join-Path $target "install.mjs")) -and
                    ([string]$originUrl -notmatch "antigravity-usage-dashboard")
                ) {
                    throw "Target $target is an unrelated Git repository ($originUrl). Use -InstallDir to pick another directory."
                }
                Write-Host "[Setup] Updating existing repository at $target ..."
                & $gitCmd.Source -C $target pull --ff-only | Out-Host
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "[Warning] git pull --ff-only returned exit code $LASTEXITCODE; continuing with existing local files."
                }
                return $target
            }
            if (-not (Test-Path -LiteralPath (Join-Path $target "install.mjs"))) {
                if ((Test-Path -LiteralPath $target) -and ((Get-ChildItem -LiteralPath $target -Force | Measure-Object).Count -gt 0)) {
                    throw "Directory $target already exists and is not empty. Use -InstallDir to pick an empty directory."
                }
                Write-Host "[Setup] Cloning antigravity-usage-dashboard into $target ..."
                & $gitCmd.Source clone --depth 1 $RepoUrl $target | Out-Host
                if ($LASTEXITCODE -ne 0) {
                    throw "git clone failed with exit code $LASTEXITCODE"
                }
                return $target
            }
        }

        Enable-Tls12
        $tmpZip = Join-Path $env:TEMP ("agy-dash-" + [Guid]::NewGuid().ToString("N").Substring(0, 8) + ".zip")
        $tmpExt = Join-Path $env:TEMP ("agy-dash-ext-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
        try {
            Write-Host "[Setup] Downloading antigravity-usage-dashboard archive from GitHub..."
            Invoke-WebRequest -Uri $RepoZipUrl -OutFile $tmpZip -UseBasicParsing -TimeoutSec 120
            Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpExt -Force
            $inner = Get-ChildItem -LiteralPath $tmpExt -Directory | Select-Object -First 1
            if (
                -not $inner -or
                -not (Test-Path -LiteralPath (Join-Path $inner.FullName "install.mjs")) -or
                -not (Test-Path -LiteralPath (Join-Path $inner.FullName "plugin\token-usage\dist\server.cjs"))
            ) {
                throw "Downloaded archive did not contain expected repository files."
            }
            Copy-TreePreservingData -SrcDir $inner.FullName -DestDir $target
        } finally {
            if (Test-Path -LiteralPath $tmpZip) { Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $tmpExt) { Remove-Item -LiteralPath $tmpExt -Recurse -Force -ErrorAction SilentlyContinue }
        }
        return $target
    }

    $nodeExe = Ensure-Node20
    $repoDir = Resolve-RepoDir
    Write-Output "[Setup] Repository directory: $repoDir"

    if (-not $SkipPlugin) {
        $installArgs = @((Join-Path $repoDir "install.mjs"))
        if (-not [string]::IsNullOrWhiteSpace($PluginDest)) {
            $installArgs += @("--dest", $PluginDest)
        }
        & $nodeExe @installArgs
        if ($LASTEXITCODE -ne 0) {
            throw "install.mjs failed with exit code $LASTEXITCODE"
        }
    }

    if (-not $SkipSync) {
        $syncArgs = @((Join-Path $repoDir "sync_usage.mjs"))
        if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
            $syncArgs += @("--data-dir", $DataDir)
        }
        if (-not [string]::IsNullOrWhiteSpace($BundleOut)) {
            $syncArgs += @("--bundle-out", $BundleOut)
        }
        & $nodeExe @syncArgs
        if ($LASTEXITCODE -ne 0) {
            throw "sync_usage.mjs failed with exit code $LASTEXITCODE"
        }
    }

    Write-Output ""
    Write-Output "[Setup] All done!"
    Write-Output "[Setup] Restart (or reopen) Antigravity and open 'Token Usage' from the left sidebar or '+' pane menu."
    Write-Output ("[Setup] Standalone browser launcher: " + (Join-Path $repoDir "open-dashboard.bat"))
}
