# Staff records and sign-in accounts

Each account can be explicitly linked to one staff member, and each staff member to at most one account. Existing records remain unlinked; names and job titles are never used to infer identity or grant access. Staff without an account remain in the directory. Bootstrap/administrative accounts may remain unlinked.

In Accounts, select the existing account, choose its Staff member and access level, then save. Do not create another login for a person who already has one. The Staff details dialog shows the linked username, role and enabled status to administrators only. Accounts and the staff-options endpoint require administrator authorization.

| Account access | Class source | Allowed class actions |
| --- | --- | --- |
| Teacher | Linked staff assignment; otherwise explicit legacy account assignment | Read assigned children and saved plans; record today's check-in/out; read reviewed essential health/emergency card |
| Class viewer | Linked staff assignment; otherwise explicit legacy account assignment | Read assigned children's names and saved activities/meals; no attendance writes or emergency cards |
| Editor | No class restriction | Existing operational permissions; no account administration or child registration paperwork |
| Administrator | No class restriction | Existing administrator permissions |

Changing a linked staff class updates the account assignment and revokes every session. Deactivating an employee disables the linked account and revokes sessions. Reactivation does not automatically re-enable the account; an administrator must enable it separately. Role, link and status changes also revoke sessions. Staff job-role edits never change account roles. Every request checks that a linked employee still exists and is active. The last enabled administrator cannot be deactivated through Staff.

Staff mutations and linked account/session changes share the authentication and class locks, in that order, and participate in the existing audited transaction. An audit failure rolls back the entire update. The database enforces the optional unique employee reference and prevents deletion of linked staff. Employee removal is deactivation rather than deletion.

Migration 026 adds the nullable unique `Accounts.staffMemberId` reference without changing existing IDs, assignments, sessions, passwords, or roles. Back up and migrate through `bash scripts/check-update.sh --access` before starting the updated server. No automatic role promotion or account creation occurs.

This does not add payroll, badge credentials, or facility-wide read-only access; those remain separate work.
