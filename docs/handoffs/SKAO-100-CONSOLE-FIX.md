# SKAO-100: Windows Docker console fix

Base: `0267cce5b9944aa3f5f0373c80f4b1236f985057` (PR #20 merged into development).

## Problem and change

The Windows pilot reports `failed to get console: The handle is invalid.` during
`SKAO.cmd update`, although `docker info` returns `linux` and Compose reports
version 5.5.1. The launcher pipes its child PowerShell output through `Out-Host`.
Compose 5.5.1 chooses automatic progress from stderr's terminal status and passes
that mode to the build display, which writes to stdout. A terminal on stderr and
redirected stdout can therefore select a console display for an invalid handle.

- Compose calls now pass `--ansi never --progress plain`, overriding inherited
  terminal preferences and keeping captured tool JSON separate from progress.
- The launcher starts PowerShell with `Start-Process -NoNewWindow -Wait -PassThru`
  to retain its console handles and propagate its exit code without an output pipe.
- Native failures identify the Compose operation and retain the original output.

The existing Git/update, backup, migration, network, certificate and data handling
remain in place. Do not reinitialize the installed pilot to address this error.

## Immediate workaround for the old script

In the same Windows PowerShell window, from the installed repository:

```powershell
$env:COMPOSE_ANSI = 'never'
$env:COMPOSE_PROGRESS = 'plain'
$env:BUILDKIT_PROGRESS = 'plain'
.\SKAO.cmd update
```

These environment values affect this PowerShell session and its child processes;
they do not change global Windows settings. Once the fix is merged and pulled,
the script supplies its own flags.

## Verification

- All five PowerShell files parse with PowerShell 7.4.13.
- 39 existing isolated automation checks pass.
- Two new checks run real PowerShell child processes with synthetic Docker output:
  captured JSON remains parseable despite stderr progress, inherited TTY settings
  and paths with spaces; a native failure stops execution and reports its operation
  and exit code.
- A third new check runs the real Windows launcher with a synthetic child script,
  a path containing spaces, stdout, stderr and a nonzero exit code. It is enabled
  in Windows PowerShell CI and skipped on this Linux host.
- CI YAML parses; the patch passes `git diff --check`.

Actual Windows PowerShell 5.1 / Docker Compose 5.5.1 behavior still needs the CI run
and a retry on the installed host. Docker, Windows networking and phone access
were not exercised here. This follow-up does not complete the remaining phone
acceptance checks for SKAO-100 or SKAO-80.

## References

- [Compose progress and ANSI flags](https://docs.docker.com/reference/cli/docker/compose/)
- [Compose 5.5.1 display selection](https://github.com/docker/compose/blob/v5.5.1/cmd/compose/compose.go)
- [Compose 5.5.1 build display](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/build_bake.go)
