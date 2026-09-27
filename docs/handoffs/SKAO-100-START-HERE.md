# SKAO-100 - reusable Docker controls

**Use `SKAO.cmd` in your existing Windows pilot folder.** Double-click it for a
menu, or run a named command:

```powershell
.\SKAO.cmd setup-phone
.\SKAO.cmd update
.\SKAO.cmd restart
.\SKAO.cmd doctor
```

These are separate commands; choose the one you need. The menu also includes
start, stop, status, logs, backup, certificate export and Windows certificate trust.

`setup-phone` detects your LAN address, configures HTTPS/firewall, checks readiness
and prints the phone URL. It requests Windows administrator access. Rerun it after
an address change or to repair settings. Existing records, secrets, certificates,
backups and release selection are retained. It never initializes another pilot.

The public certificate and device details are generated in `.pilot/phone/`.
Installing/trusting that certificate on the phone is the one-time device action
the Windows script cannot perform. A trusted network must already be marked
Private in Windows; setup will explain if it is not eligible.

`update` pulls the already reviewed `development` or `main` release by fast-forward,
then runs the existing backup/update workflow. It refuses uncommitted work and
feature branches. Repeating the same release performs a health check; `restart`
keeps the currently selected release.

## Apply the ZIP

Extract outside the repository. The package includes apply scripts, a patch and
the changed files for review. Apply from the extracted folder to the repository
you want to review:

```bash
bash apply.sh /path/to/ska_organizer
```

Or on Windows:

```powershell
.\APPLY.cmd "C:\path\to\ska_organizer-pilot"
```

The apply script checks the complete patch before staging its changes. It does
not commit, push, merge, deploy, or reset existing work. If the patch cannot apply,
it stops. Apply once; the runtime commands can be rerun. Do not copy the entire
`files/` folder over SKAO-80 changes; use the patch/apply script to retain both.

## Validation

Run the included isolated automation checks with:

```powershell
powershell.exe -NoProfile -File .\scripts\tests\pilot-automation.tests.ps1
```

The tests mock Docker, Windows networking/firewall and Git; they do not touch the
installed pilot. Windows PowerShell 5.1 execution is also added to CI. See
`SKAO-100-VERIFICATION.md` for the results actually obtained here.

After applying the code to the existing Windows pilot, `setup-phone` can run
against its saved images without rebuilding the app. `doctor` reports computer
checks; phone connectivity, certificate trust, sign-in and PWA installation still
need your phone. Test, commit and merge using your normal review workflow.

Base: `development` commit `071c9577555175834890175bdc3f2801df3329ca`. This package
contains only SKAO-100 changes and is compatible with the separate SKAO-80 patch.
SKAO-100 remains In Progress in Sprint 1 until the Windows/phone review is complete.
Full command behavior is in [pilot-commands.md](../pilot-commands.md).
