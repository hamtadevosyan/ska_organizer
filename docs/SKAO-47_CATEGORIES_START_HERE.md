# SKAO-47 template groups and enrollment progress

Apply this follow-up after the SKAO-47 administrator-only documentation update. It also works with the latest combined registration bundle, which already includes that policy. Develop and commit on Ubuntu; the Pi only pulls merged code.

From the repository root, with normal client/server stopped:

```bash
bash ~/Downloads/SKAO-47-template-groups/apply-fix.sh
bash scripts/check-update.sh
```

`check-update.sh` retains the database backup, applies pending migrations, and runs the normal checks. Migration 019 assigns existing blank templates to Children; their documents, IDs, immutable file revisions and review history remain. Run the script using your normal account and existing PostgreSQL configuration. This patch introduces no new dependencies or system settings.

## Try it

1. As administrator, open Registration forms → Add blank form. Choose **Template for: Children, Employees or Facility**; choose the document type separately, and mark whether it is required. Upload a blank PDF/JPG/PNG. Filter templates by group.
2. Upload one required child form, a required employee form and a required facility form. Only the child form should appear in a child's checklist. Template groups stay fixed after upload; upload a separate template for another group. This prevents moving a requirement away from children with submitted documents.
3. As administrator or editor, add a child with first name, last name and date of birth. Room and notes are optional. Save without attaching paperwork. The saved profile opens automatically.
4. Administrators see missing child forms, missing basic information on older records, the completion percentage and the detailed checklist. Upload each completed required form and explicitly review it after checking signatures and required fields. Enrollment reaches **100%** only when basic information and every required current child form are complete. Replacing or updating a required form makes it incomplete until reviewed again.
5. Editors see only a percentage and a general incomplete-enrollment warning. They cannot read forms, contracts, medical information, submissions or missing-form names. Read-only accounts cannot request this progress indicator or documentation. Normal operational profiles and attendance remain unchanged.

The percentage counts three basic fields (first name, last name, date of birth) plus each required child form. With those basic fields present and one required form missing, it is 75%. An unconfigured child-template catalog shows completion unverified rather than 100%. Optional forms do not prevent completion. Active enrollment/room occupancy remain separate: registering basic information does not falsely certify paperwork completion.

Employee and facility categories organize administrator-only **blank templates** and their version history. This update does not add employee/facility completed-document records or a parent signing portal.

## Before committing

Review the diff and complete the scripts' checks. Native PostgreSQL and browser/device checks should be run on your Ubuntu environment; the attached validation report describes what ran here. Then commit, push and merge yourself. On the Pi, pull development and run `bash SKAO.sh update`.
