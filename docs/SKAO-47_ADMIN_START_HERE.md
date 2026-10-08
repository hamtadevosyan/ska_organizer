# SKAO-47 — administrator-only documentation

Apply this follow-up after the registration checklist update. Extract
`SKAO-47-admin-only-documents.zip` into Downloads, stop the normal client/server,
and run from your Ubuntu development checkout:

```bash
bash ~/Downloads/SKAO-47-admin-only-documents/apply-fix.sh &&
bash scripts/check-update.sh
```

The patch checks compatibility before writing, preserves unrelated edits, and
is safe to reapply. It performs no commit, push, deployment or system settings
change. If the previous registration update has not been applied yet, apply it
first and install its client dependencies as described in its START_HERE.

Only administrators now have access to child files, contracts, medical and
insurance paperwork, registration checklists and blank templates. Teacher
(editor) and read-only accounts retain their operational roster access and
see no documentation section or registration forms menu. They do not receive
registration completion details. Direct file, historical revision, checklist
and template API requests are also denied.

Older stored document grants are ignored immediately by the updated server.
Account management cannot grant documentation access to a non-administrator;
saving a legacy account clears that stored grant. Administrator demotion signs
out existing sessions and removes documentation access. Existing paperwork,
file versions, mappings and review records are preserved; no migration is
needed for this policy change.

## Acceptance check

1. As an administrator, open a child's documentation and registration checklist.
   Preview a saved file and a blank template, and confirm the packet still works.
2. Sign in as a teacher/editor and a read-only user. Open the same child's profile.
   The roster/profile remains usable, with no Documents or Registration checklist.
   Registration forms must be absent from navigation; its direct route is denied.
3. As a teacher/editor, add a fictional child. There must be no option to open
   documentation after saving. Read-only operational restrictions stay in place.
4. Check Accounts: there is no independent documentation-access grant control.

After acceptance, commit/push on the development machine and merge as usual.
The Pi only pulls merged development and runs `bash SKAO.sh update`. Reopen the
app after deployment so it loads the updated UI and permission state.
