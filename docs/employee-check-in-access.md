# Employee access requires check-in

An employee's linked, non-administrator account can open the application only while that employee has an active clock session. This applies to linked editors, teachers and Class viewers. Job titles and classroom assignments do not grant an exception. Administrator accounts retain access so they can manage staff check-ins, even when the administrator is linked to a staff record. Unlinked organization accounts keep their existing role permissions; administrators should link each employee's account to the correct active Staff record.

When an employee is not checked in, the app displays:

> Please check in to continue. Use the check-in station or ask an administrator to check you in.

The employee can refresh after checking in, change their password, or sign out. They cannot use their personal account to check in. The registered PIN station and administrator/manager staff clock retain their existing separate permissions. An editor who is subject to this gate must first use the station or ask an administrator.

The API checks the current employee link, active employment and encrypted clock ledger. Off-clock accounts cannot read or write protected operational information, classroom plans, attendance, health/emergency details, files or management projections through a saved link or direct request. The safe authentication endpoints remain usable. Off-clock session responses contain only the account's own minimal identity and gate state, without class, staff, time totals or pay data.

Checking in unlocks only the account's existing permissions. A teacher still sees their assigned class and approved child-safety information; a viewer still cannot modify records. Checking in never grants payroll or document privileges. Checking out blocks subsequent protected API requests. Open employee views recheck status every five seconds while visible and on focus/reconnect; a verification cover hides and disables the protected view during focus checks while preserving drafts when the same checked-in session is confirmed; a returned gate denial clears the protected view and pending requests. The screen cannot erase information someone has already seen or copied.

An overnight session remains checked in until an actual checkout. The application does not invent a midnight checkout or change time/pay records. Voided, closed, future or malformed clock records do not grant access. If the server cannot verify check-in because the clock ledger or original encryption key is unavailable, employee access remains locked with a verification/retry message. Administrators can still diagnose and restore the original configuration. No new encryption key should be generated for an existing encrypted database.

This follow-up adds no dependency, migration, payroll rule or personal check-in action. It uses the existing encrypted clock records and the original payroll key. It does not store employee access decisions, classroom data or payroll in offline browser storage.

## Testing on Ubuntu

Stop normal client/server processes and run from the repository root:

```bash
bash scripts/check-update.sh --payroll
```

Use fictional records to verify a linked employee is gated before check-in, unlocks after station/admin check-in, and locks again after checkout. Try direct protected URLs and API requests while off clock. Verify a checked-in teacher remains limited to their class, password changes and sign-out work while gated, an administrator can manage the clock, and station mode remains isolated from personal accounts.
