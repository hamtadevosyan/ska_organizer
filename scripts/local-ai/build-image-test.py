#!/usr/bin/env python3
"""Build one readable PowerShell download from the checked-in SD1.5 test files."""
import argparse
import hashlib
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[2]
FILES = (
    "scripts/local-ai/image-downloads.json",
    "scripts/local-ai/windows/Setup-ActivityImages.ps1",
    "scripts/local-ai/windows/run-activity-images.py",
    "scripts/local-ai/windows/activity_image_layouts.py",
)

HEADER = r'''#Requires -Version 5.1
# Generated from the SKAO repository with scripts/local-ai/build-image-test.py.
# This file contains its companion scripts as readable text. It downloads only
# the pinned official runtime/model/extractor when normal setup is requested.
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$TestGeneration,
    [switch]$CompareSDXL,
    [switch]$SimplePrompts,
    [switch]$GuidedLayout,
    [ValidateSet(1, 4)][int]$Count = 1,
    [string]$ArchivePath,
    [string]$RefreshReview
)
$ErrorActionPreference = 'Stop'

function Assert-SkaoImageToolPath {
    param([string]$Path)
    $candidate = [IO.Path]::GetFullPath($Path)
    while ($candidate) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'IMG_PATH: A tool path contains a linked entry; it was preserved.'
            }
        }
        $parent = [IO.Directory]::GetParent($candidate)
        if (!$parent) { break }
        $candidate = $parent.FullName
    }
}

try {
    if ($PSBoundParameters.ContainsKey('RefreshReview') -and ([string]::IsNullOrWhiteSpace($RefreshReview) -or
        $Check -or $TestGeneration -or $CompareSDXL -or $SimplePrompts -or $GuidedLayout -or
        $PSBoundParameters.ContainsKey('ArchivePath') -or $PSBoundParameters.ContainsKey('Count'))) {
        throw 'IMG_ARGUMENTS: -RefreshReview needs a folder path and cannot be combined with other setup or generation options.'
    }
    if ($Check -and ($TestGeneration -or $ArchivePath)) {
        throw 'IMG_ARGUMENTS: -Check cannot install, download or generate.'
    }
    if ($SimplePrompts -and (!$TestGeneration -or $Check)) {
        throw 'IMG_ARGUMENTS: -SimplePrompts requires -TestGeneration and cannot be combined with -Check.'
    }
    if ($GuidedLayout -and !$CompareSDXL) {
        throw 'IMG_ARGUMENTS: -GuidedLayout requires -CompareSDXL.'
    }
    if ($CompareSDXL -and $ArchivePath) {
        throw 'IMG_ARGUMENTS: SDXL comparison uses the installed runtime and cannot accept an installation archive.'
    }
    if (!$env:LOCALAPPDATA) { throw 'IMG_ACCOUNT: LOCALAPPDATA is unavailable for this account.' }
'''

FOOTER = r'''
    Assert-SkaoImageToolPath -Path $toolRoot
    foreach ($entry in $payload) {
        $target = Join-Path $toolRoot $entry.Path
        Assert-SkaoImageToolPath -Path $target
        if (Test-Path -LiteralPath $target) {
            if (!(Test-Path -LiteralPath $target -PathType Leaf) -or
                (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $entry.Sha256) {
                throw 'IMG_TOOL_CONFLICT: A saved companion script differs; it was preserved.'
            }
        }
        elseif ($Check) {
            throw 'IMG_NOT_CONFIGURED: Run this file once without -Check before checking the installation. No files were changed.'
        }
        else {
            $directory = Split-Path -Parent $target
            [void](New-Item -ItemType Directory -Path $directory -Force)
            $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($entry.Content)
            $stream = New-Object IO.FileStream($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $stream.Write($bytes, 0, $bytes.Length) }
            finally { $stream.Dispose() }
            if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $entry.Sha256) {
                throw 'IMG_TOOL_HASH: A companion script could not be written correctly.'
            }
        }
    }
    $options = @{}
    if ($PSBoundParameters.ContainsKey('RefreshReview')) {
        $options.RefreshReview = $RefreshReview
    }
    else {
        $options.Count = $Count
        if ($Check) { $options.Check = $true }
        if ($TestGeneration) { $options.TestGeneration = $true }
        if ($CompareSDXL) { $options.CompareSDXL = $true }
        if ($SimplePrompts) { $options.SimplePrompts = $true }
        if ($GuidedLayout) { $options.GuidedLayout = $true }
        if ($ArchivePath) { $options.ArchivePath = $ArchivePath }
    }
    & (Join-Path $toolRoot 'scripts/local-ai/windows/Setup-ActivityImages.ps1') @options
    exit $LASTEXITCODE
}
catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
'''


def build(output: Path):
    payload = []
    for relative in FILES:
        content = (REPOSITORY / relative).read_text(encoding="utf-8-sig")
        if any(line == "'@" for line in content.splitlines()):
            raise ValueError("A source contains the PowerShell here-string delimiter")
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        payload.append((relative, digest, content))
    identity = hashlib.sha256("\n".join(path + ":" + digest for path, digest, _ in payload).encode()).hexdigest()[:20]
    text = HEADER + "    $toolRoot = Join-Path $env:LOCALAPPDATA 'SKAO-ActivityImageTools/" + identity + "'\n"
    text += "    $payload = @(\n"
    for relative, digest, content in payload:
        text += "        @{ Path = '" + relative + "'; Sha256 = '" + digest + "'; Content = @'\n"
        text += content + "\n'@\n        }\n"
    text += "    )\n" + FOOTER
    output.parent.mkdir(parents=True, exist_ok=True)
    # A BOM is needed for literal Unicode under Windows PowerShell 5.1.
    output.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
    print("Built " + str(output.resolve()))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args().output)
