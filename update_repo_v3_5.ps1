# update_repo_v3_5.ps1 -- ASCII only. Overlays docrecon_v3_5.zip (docflow 1.1.0: rule F18 REVIEW_NEEDS_SIGNOFF, cases D43-D45, ADR-0006) onto C:\docrecon_clean.
# Stops on any red step (checks $LASTEXITCODE). Prerequisite: C:\Users\mpyas\Downloads\docrecon_v3_5.zip

$ErrorActionPreference = "Stop"
chcp 65001 | Out-Null
$OutputEncoding = [System.Text.UTF8Encoding]::new()
function Check($step) { if ($LASTEXITCODE -ne 0) { throw "STOP: $step failed (exit $LASTEXITCODE). Do not push. Send the last 30 lines." } }

$Repo = "C:\docrecon_clean"; $Zip = "C:\Users\mpyas\Downloads\docrecon_v3_5.zip"; $Tmp = "C:\_dr_tmp"
if (-not (Test-Path "$Repo\.git")) { throw "STOP: not a git repo" }
if (-not (Test-Path $Zip))         { throw "STOP: zip not found: $Zip" }
Set-Location $Repo
git status --short | Measure-Object -Line       # expected 0 (clean)

if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
Remove-Item "$Repo\cases", "$Repo\cases-docflow" -Recurse -Force
Copy-Item -Path "$Tmp\docrecon\*" -Destination $Repo -Recurse -Force
Get-ChildItem -Path "$Tmp\docrecon" -Force | Where-Object { $_.Name -like ".*" } | Copy-Item -Destination $Repo -Recurse -Force
Remove-Item $Tmp -Recurse -Force

Write-Host "---- SENTINELS ----"
Write-Host ("S1 JS docflow VERSION 1.1.0 : " + [bool](Select-String -Path "$Repo\web\docflow.js" -Pattern "VERSION = .1.1.0." -Quiet))
Write-Host ("S2 C# docflow Version 1.1.0 : " + [bool](Select-String -Path "$Repo\src\Dalteno.DocFlow\Engine.cs" -Pattern "Version = .1.1.0." -Quiet))
Write-Host ("S3 F18 in JS engine         : " + [bool](Select-String -Path "$Repo\web\docflow.js" -Pattern "REVIEW_NEEDS_SIGNOFF" -Quiet))
Write-Host ("S4 F18 C# test              : " + [bool](Select-String -Path "$Repo\tests\Dalteno.DocFlow.Tests\SharedCasesTests.cs" -Pattern "F18_ReviewStopsTheGatedApproval" -Quiet))
Write-Host ("S5 D45 case + golden        : " + ((Test-Path "$Repo\cases-docflow\D45_signoff_cannot_override_blocked_or_skip_reason.json") -and (Test-Path "$Repo\cases-docflow\golden\D45_signoff_cannot_override_blocked_or_skip_reason.report.json")))
Write-Host ("S6 ADR-0006 present         : " + (Test-Path "$Repo\docs\adr\0006-review-needs-signoff.md"))
Write-Host "-------------------"
# all six expected True; if any False -> stop here and send the output

git add -A                                   # stage the overlay first, so the diff below only shows real generator drift
node cases/generate.mjs
Check "generate"
node cases-docflow/generate.mjs
Check "generate docflow"
git diff --exit-code --stat -- cases cases-docflow
Check "generator drift (cases must match generator output)"
node --test web/tests/cases.test.mjs web/tests/docflow.test.mjs web/tests/formmerge.test.mjs
Check "node --test"
# expected: pass 183, fail 0  (72 + 50 + 61)
dotnet test
Check "dotnet test"
# expected: Dalteno.DocRecon.Tests total 181 failed 0 ; Dalteno.DocFlow.Tests total 96 failed 0  (45 expectation + 45 golden-parity + 6 unit)

git add -A
git commit -m "docflow 1.1.0: F18 REVIEW_NEEDS_SIGNOFF - a REVIEW reconciliation stops the gated approval until a reasoned acceptance is recorded; cases D43-D45; ADR-0006"
Check "git commit"
git push origin main
Check "git push"
# then: Actions -> run #9 green -> job '.NET library' -> 'Run dotnet test' -> screenshot of the Passed lines
