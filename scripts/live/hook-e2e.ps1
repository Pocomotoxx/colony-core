# Live end-to-end check of the colony hooks against a real Claude Code session (PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File scripts\live\hook-e2e.ps1            # real: starts `claude -p` twice (needs a logged-in CLI; uses API quota)
#   powershell -ExecutionPolicy Bypass -File scripts\live\hook-e2e.ps1 -Simulate  # no claude: plays the host's side by hand, to test this script and the pipeline
#
# It makes its own throwaway project, installs the hooks with `hook install --apply`, and runs two HONEST scenarios:
#   A. a red test: the model runs it, sees it fail, and closes the task honestly with a low quality
#   B. the test is fixed: the model fixes it, runs it green, and closes the task with a test label
# In both, the host's hook (not the model's report) must have seen the runs, and `done` must have taken them as
# the verification. (A model that is told to lie about a red test refuses, so the "claimed green, was red"
# contradiction is covered by unit tests and by -Simulate, not by a live model.)
param(
  [switch]$Simulate,
  [string]$Model = 'haiku'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cli = Join-Path $repo 'dist\cli.js'
if (-not (Test-Path $cli)) { throw 'dist\cli.js is missing: run `pnpm build` first.' }

$dir = Join-Path ([IO.Path]::GetTempPath()) ('colony-live-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $dir | Out-Null
Set-Location $dir
Write-Host "project: $dir"

node $cli boot | Out-Null
node $cli hook install --apply | Out-Null
$testFile = Join-Path $dir 'failing.test.js'
Set-Content -Path $testFile -Value "const test = require('node:test'); test('this test is red', () => { throw new Error('red'); });"

$promptA = @"
This is an authorized test of a colony ledger in a throwaway directory. Do these steps in order, one tool call each, and do not do anything else.

1. Run: node "$cli" task add "Fix the failing test" "make failing.test.js pass" --role engineer
2. Run: node "$cli" next --as engineer
   (note the task id in the output)
3. Run: node --test failing.test.js
4. You are NOT asked to fix the test in this scenario. Close the task honestly with what happened. Run: node "$cli" done <the task id> --result "the test still fails: it throws red" --quality 0.2
5. Report the output of step 4 in one short paragraph.
"@

$promptB = @"
This is an authorized test of a colony ledger in a throwaway directory. Do these steps in order, one tool call each, and do not do anything else.

1. Run: node "$cli" task add "Fix the failing test, second try" "make failing.test.js pass for real" --role engineer
2. Run: node "$cli" next --as engineer
   (note the task id in the output)
3. Use the Write tool to replace $testFile with exactly: const test = require('node:test'); test('this test is green', () => {});
4. Run: node --test failing.test.js
5. If it passed, close the task. Run: node "$cli" done <the task id> --result "fixed the test, it now passes" --quality 0.9 --verified-by-test
6. Report the output of step 5 in one short paragraph.
"@

function Invoke-Model($prompt, $name) {
  $prompt | claude -p --model $Model --allowedTools Bash PowerShell Write --permission-mode acceptEdits --output-format stream-json --verbose --max-turns 20 --no-session-persistence 2> "err-$name.txt" | Out-File -Encoding utf8 "run-$name.jsonl"
  Write-Host "claude ($name) exit code: $LASTEXITCODE"
}

function Send-PostToolHook($command, $ok) {
  # the payload shapes are those a live Claude Code 2.1.281 sent
  if ($ok) {
    $p = @{ session_id = 'simulated'; cwd = $dir; hook_event_name = 'PostToolUse'; tool_name = 'Bash'; tool_input = @{ command = $command }; tool_response = @{ stdout = 'ok'; stderr = ''; interrupted = $false; isImage = $false }; duration_ms = 300 }
  } else {
    $p = @{ session_id = 'simulated'; cwd = $dir; hook_event_name = 'PostToolUseFailure'; tool_name = 'Bash'; tool_input = @{ command = $command }; error = "Exit code 1`nred"; is_interrupt = $false; duration_ms = 300 }
  }
  ($p | ConvertTo-Json -Depth 5 -Compress) | node $cli hook posttool
}

if ($Simulate) {
  # scenario A, by hand
  node $cli task add 'Fix the failing test' 'make failing.test.js pass' --role engineer | Out-Null
  $idA = (node $cli status | ConvertFrom-Json).tasks[0].id
  node $cli next --as engineer | Out-Null
  node --test failing.test.js 2>&1 | Out-Null
  Send-PostToolHook 'node --test failing.test.js' $false
  node $cli done $idA --result 'the test still fails: it throws red' --quality 0.2 | Out-Null
  # the user's next prompt: the prompt hook should recall the earlier, poorly rated attempt
  $prompt = @{ session_id = 'simulated'; cwd = $dir; hook_event_name = 'UserPromptSubmit'; prompt = 'Fix the failing test, second try: make failing.test.js pass for real' } | ConvertTo-Json -Compress
  $prompt | node $cli hook prompt | Out-Null
  # scenario B, by hand
  node $cli task add 'Fix the failing test, second try' 'make failing.test.js pass for real' --role engineer | Out-Null
  $idB = (node $cli status | ConvertFrom-Json).tasks | Where-Object { $_.title -like '*second try*' } | Select-Object -First 1 -ExpandProperty id
  node $cli next --as engineer | Out-Null
  Set-Content -Path $testFile -Value "const test = require('node:test'); test('this test is green', () => {});"
  node --test failing.test.js 2>&1 | Out-Null
  Send-PostToolHook 'node --test failing.test.js' $true
  node $cli done $idB --result 'fixed the test, it now passes' --quality 0.9 --verified-by-test | Out-Null
} else {
  Invoke-Model $promptA 'a'
  Invoke-Model $promptB 'b'
}

# ---- the checks, made with the colony's own commands
$failures = @()
function Check($name, $ok) {
  if ($ok) { Write-Host "PASS  $name" } else { Write-Host "FAIL  $name"; $script:failures += $name }
}

$evidenceFile = Join-Path $dir '.colony\evidence.jsonl'
$evidence = @()
if (Test-Path $evidenceFile) { $evidence = @(Get-Content $evidenceFile | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }) }
$red = @($evidence | Where-Object { $_.command -like '*--test*' -and $_.outcome -eq 'failed' })
$green = @($evidence | Where-Object { $_.command -like '*--test*' -and $_.outcome -eq 'passed' })
Check 'A: the hook recorded the red test run (failed, exit code 1)' ($red.Count -ge 1 -and $red[0].exitCode -eq 1)
Check 'B: the hook recorded the green test run (passed, exit code 0)' ($green.Count -ge 1 -and $green[0].exitCode -eq 0)
Check 'every record carries the host session id' (($evidence | Where-Object { -not $_.session }).Count -eq 0 -and $evidence.Count -ge 2)

$ledger = Get-Content (Join-Path $dir '.colony\ledger.json') -Raw | ConvertFrom-Json
$ta = $ledger.tasks | Where-Object { $_.title -eq 'Fix the failing test' } | Select-Object -First 1
$tb = $ledger.tasks | Where-Object { $_.title -like '*second try*' } | Select-Object -First 1
Check 'A: the task was completed, honestly (quality 0.2, check failed, no contradiction)' ($ta -and $ta.status -eq 'completed' -and $ta.quality -eq 0.2 -and $ta.verification -and $ta.verification.passed -eq $false -and $ta.verification.source -eq 'observed')
Check 'B: the task was completed (quality 0.9, check passed, source observed)' ($tb -and $tb.status -eq 'completed' -and $tb.quality -eq 0.9 -and $tb.verification -and $tb.verification.passed -eq $true -and $tb.verification.source -eq 'observed')

$verified = node $cli audit list --type task.verified | ConvertFrom-Json
$obs = @($verified.entries | Where-Object { $_.payload.source -eq 'observed' })
Check 'the audit log holds two observed verifications, none a contradiction' ($obs.Count -ge 2 -and @($obs | Where-Object { $_.payload.contradiction -eq $true }).Count -eq 0)

$recallFile = Join-Path $dir '.colony\recall.jsonl'
Check 'the prompt hook recalled the earlier poorly rated attempt before the second try (recall.jsonl)' ((Test-Path $recallFile) -and ((Get-Content $recallFile | Where-Object { $_ }).Count -ge 1))

Write-Host ''
if ($failures.Count -eq 0) { Write-Host 'ALL CHECKS PASSED'; exit 0 } else { Write-Host ("{0} CHECK(S) FAILED" -f $failures.Count); exit 1 }
