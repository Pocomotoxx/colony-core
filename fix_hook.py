import os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src'))
def edit(p, pairs):
    s = open(p, encoding='utf-8', newline='').read()
    crlf = '\r\n' in s
    t = s.replace('\r\n', '\n')
    for a, b in pairs:
        assert a in t, (p, a[:60])
        t = t.replace(a, b, 1)
    open(p, 'w', encoding='utf-8', newline='').write(t.replace('\n', '\r\n') if crlf else t)

edit('hook/cli.ts', [
 (" * - unreadable input -> exit 2: a guard that cannot read its input must not let the tool through.\n */",
  " * - unreadable input, or any internal failure -> exit 2: a guard that cannot do its job must not let\n *   the tool through. (An uncaught crash would exit 1, which a host treats as a non-blocking error.)\n */"),
 ("  const verdict = await evaluatePreToolUse(input, projectDir);\n",
  "  let verdict;\n  try {\n    verdict = await evaluatePreToolUse(input, projectDir);\n  } catch (err) {\n    return { code: 2, stdout: '', stderr: `Colony guard: the check failed (${err instanceof Error ? err.message : String(err)}), so the tool call is refused.\n` };\n  }\n"),
])
edit('cli.ts', [
 ("  const stdinText = sub === 'pretool' ? await readStdin() : '';\n  const run = await runHook(sub, stdinText, process.cwd(), dirIndex > 0 ? process.argv[dirIndex + 1] : undefined);\n  process.stdout.write(run.stdout);\n  process.stderr.write(run.stderr);\n  process.exitCode = run.code;",
  "  try {\n    const stdinText = sub === 'pretool' ? await readStdin() : '';\n    const run = await runHook(sub, stdinText, process.cwd(), dirIndex > 0 ? process.argv[dirIndex + 1] : undefined);\n    process.stdout.write(run.stdout);\n    process.stderr.write(run.stderr);\n    process.exitCode = run.code;\n  } catch (err) {\n    // fail closed: an uncaught crash would exit 1, which a host treats as a non-blocking error\n    process.stderr.write(`Colony guard: the hook failed (${err instanceof Error ? err.message : String(err)}), so the tool call is refused.\n`);\n    process.exitCode = 2;\n  }"),
])
print('ok')
