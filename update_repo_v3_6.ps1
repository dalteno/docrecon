# update_repo_v3_6.ps1 -- ASCII only. Overlays docrecon_v3_6.zip (web bundles generated from the cases (web/cases.json 59, web/cases-docflow.json 45), CI drift gate widened, package.json 1.1.0) onto C:\docrecon_clean.
# Stops on any red step (checks $LASTEXITCODE). Prerequisite: C:\Users\mpyas\Downloads\docrecon_v3_6.zip

$ErrorActionPreference = "Stop"
chcp 65001 | Out-Null
$OutputEncoding = [System.Text.UTF8Encoding]::new()
function Check($step) { if ($LASTEXITCODE -ne 0) { throw "STOP: $step failed (exit $LASTEXITCODE). Do not push. Send the last 30 lines." } }

$Repo = "C:\docrecon_clean"; $Zip = "C:\Users\mpyas\Downloads\docrecon_v3_6.zip"; $Tmp = "C:\_dr_tmp"
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
Write-Host ("S1 generator writes web/cases.json      : " + [bool](Select-String -Path "$Repo\cases\generate.mjs" -Pattern "web., .cases.json" -Quiet))
Write-Host ("S2 docflow generator writes bundle      : " + [bool](Select-String -Path "$Repo\cases-docflow\generate.mjs" -Pattern "cases-docflow.json" -Quiet))
Write-Host ("S3 CI drift gate covers web bundles     : " + [bool](Select-String -Path "$Repo\.github\workflows\ci.yml" -Pattern "web/cases.json web/cases-docflow.json" -Quiet))
Write-Host ("S4 package.json 1.1.0                   : " + [bool](Select-String -Path "$Repo\package.json" -Pattern '"version": "1.1.0"' -Quiet))
Write-Host ("S5 web/cases.json has 59 cases          : " + (((Get-Content "$Repo\web\cases.json" -Raw | ConvertFrom-Json).Count) -eq 59))
Write-Host ("S6 web/cases-docflow.json has 45 cases  : " + (((Get-Content "$Repo\web\cases-docflow.json" -Raw | ConvertFrom-Json).Count) -eq 45))
Write-Host "-------------------"
# all six expected True; if any False -> stop here and send the output

git add -A                                   # stage the overlay first, so the diff below only shows real generator drift
node cases/generate.mjs
Check "generate"
node cases-docflow/generate.mjs
Check "generate docflow"
git diff --exit-code --stat -- cases cases-docflow web/cases.json web/cases-docflow.json
Check "generator drift (cases must match generator output)"
node --test web/tests/cases.test.mjs web/tests/docflow.test.mjs web/tests/formmerge.test.mjs
Check "node --test"
# expected: pass 183, fail 0  (72 + 50 + 61)
dotnet test
Check "dotnet test"
# expected: Dalteno.DocRecon.Tests total 181 failed 0 ; Dalteno.DocFlow.Tests total 96 failed 0  (45 expectation + 45 golden-parity + 6 unit)

git add -A
git commit -m "web/cases.json and web/cases-docflow.json are now written by the generators (were a stale hand copy: 52 of 59); CI drift gate covers them; package.json 1.1.0"
Check "git commit"
git push origin main
Check "git push"
# then: Actions -> run #10 green -> job '.NET library' -> 'Run dotnet test' -> screenshot of the Passed lines
