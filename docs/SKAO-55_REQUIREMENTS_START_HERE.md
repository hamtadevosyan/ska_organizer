# SKAO-55 — required certificates by name and mobile staff details

This incremental patch applies after the existing SKAO-55 upload/reminder update. Administrators can add a required employee certificate by name without a blank template. Staff has a read-only details view on phones and desktops. No dependencies or migrations are added.

## Use the correct branch first

On your Ubuntu development machine, open the checkout containing your current SKAO-55 work:

```bash
cd ~/workspace/ska_organizer
git status --short
git branch --show-current
```

If you are still on **SKAO-47** with the unpushed SKAO-55 commit, create the correct branch from that commit:

```bash
git switch -c SKAO-55
```

If you already created **SKAO-55**, use that branch instead:

```bash
git switch SKAO-55
```

Run only the command that matches your branch state. Creating the new branch keeps the existing commit. Do not reset or discard your work.

## Apply and check

Extract `SKAO-55-required-certificates-mobile.zip` into Downloads. From the repository root:

```bash
bash ~/Downloads/SKAO-55-required-certificates-mobile/apply-fix.sh
git diff --stat
bash scripts/check-update.sh
```

Stop the normal development client/server before check-update. It uses your configured application and separate test databases, retains a backup, and stops at a failed check. The patch application checks all changes before writing; a mismatch keeps your files intact. It does not commit, push, deploy or change OS, router or device settings.

## Try the two changes

1. As administrator, open **Staff → Add employee requirement**, or **Registration forms → Add employee requirement**.
2. Enter a certificate name such as CPR certification. Employees and **Required for every active employee** are already selected. Choose its category and whether an expiration date is required. Leave the optional blank file empty and save.
3. Open an active employee's **Documents & training**. The certificate appears as **Missing document**. Attach the employee's actual certificate, enter/confirm its dates, save and mark the evidence reviewed. A blank template is never needed for that requirement. All active employees use this required list.
4. On a phone, tap **More → Staff**, search for a staff member, then tap **View details**. Check their name, job role, room and active status. Close with Done or the close button.
5. As an editor or read-only user, check that basic details are available. Editors retain renewal summaries; only administrators can open private employee documents. Opening basic details must preserve an unsaved document draft.

Focused checks, if needed:

```bash
npm --prefix client test -- RegistrationForms Staff
npm --prefix client run test:browser -- staff-requirements-mobile.spec.ts staff-compliance.spec.ts
npm --prefix client run build
```

These browser checks use synthetic records and isolated servers. The known selective PDF compatibility bug remains SKAO-105.

## Commit and push from Ubuntu after testing

Review `FILES.txt` and the diff. Stage only this patch's files:

```bash
while IFS= read -r skao_patch_file; do
  git add -- "$skao_patch_file"
done < ~/Downloads/SKAO-55-required-certificates-mobile/FILES.txt
git diff --cached --stat
git commit -m "SKAO-55: add required certificates by name and mobile staff details"
git push -u origin SKAO-55
```

Create/update the pull request **SKAO-55 → development**. Keep SKAO-55 In Progress until your checks and merge are complete. On the Pi, after merging:

```bash
git switch development
git pull --ff-only origin development
bash SKAO.sh update
```

Development and Git pushes stay on Ubuntu; the Pi only pulls the merged code and runs the update.
