# Internal pilot acceptance

This is an uncompleted checklist. Record results for the exact final commit after
installation. Use synthetic children, accounts and records until acceptance is
complete. A static build alone cannot prove deployment, permissions or recovery.

Record: release commit, Windows/Docker version, facility time zone, HTTPS address,
test date, operator, test results, backup name and verification filename.

## Development and CI gates

On Ubuntu, stop the usual client and server terminals and run from the repository:

```bash
cd ~/workspace/ska_organizer
bash scripts/check-update.sh
```

Install dependencies and Playwright Chromium first if the runbook requires it.
Use the full command, without `--inventory`. Its PostgreSQL tests use the separate
`_test` database. It backs up/migrates your configured development database before
running tests; do not point it at the Windows pilot. Keep the summary and the exact
commit together. Do not lengthen every test timeout or disable authorization to
make failures disappear.

- [ ] Mock API suite, PostgreSQL suite and persistence/restart verification pass.
- [ ] Client component tests, production build and lint pass.
- [ ] All browser workflows pass, including Reports room selection/CSV/print.
- [ ] GitHub Client build and planner tests, Server persistence tests, and Pilot
  deployment checks pass for the candidate commit. The pilot job builds the real
  images, exercises HTTPS and secure cookies, and restores a synthetic snapshot
  into an isolated database. Its fixture covers meals/accounts; the fuller pilot
  exercise below covers the remaining domains.
- [ ] Windows PowerShell helper syntax and actual installation commands succeed.

## Reachability and accounts

- [ ] Chrome trusts the exact pilot HTTPS address without bypassing warnings.
- [ ] Ports 3001 and 5432 are not published on the Windows host.
- [ ] An incognito request to `/api/rooms` returns 401 and no operational data.
- [ ] Administrator can manage accounts. Editor can perform permitted daily work.
  Viewer can read but cannot save. Disabled accounts cannot continue operating.
- [ ] New-account password change, sign-out, and an expired session leave no private
  screen visible. A failed save is not shown as saved.
- [ ] Restart the pilot, then Docker Desktop, then Windows/sign-in. On each restart,
  wait for healthy status, sign in and verify saved records remain.
- [ ] Stop/start is deliberate and clear: staff do not need to manage services.

## Synthetic daily operation

| Domain | Exercise | What must remain after reload and recovery |
|---|---|---|
| Accounts/staff | Create a synthetic editor/viewer and staff member | Role, account status, staff record; fresh sign-in required after restore |
| Rooms/children | Create a room and synthetic child, assign the child | Valid age range/capacity and correct child-room relationship |
| Attendance | Check in and out, make a permitted correction | Times, status, attribution and correction history |
| Meals/recipes | Create meals/ingredients and recipe quantities | Stable links and correctly scaled shopping quantities |
| Weekly meals | Save two different dated weeks | Separate dates, selections and saved quantities |
| Inventory | Create a group/item, record count/use | Quantity, group, units and attributed movement history |
| Purchasing | Receive a purchase for linked food | One receipt/stock change; retry does not duplicate it |
| Activities | Save a room's full-day schedule with several entries | Every scheduled entry/date/room; no artificial three-entry cap |
| Reports | Read attendance/purchases, filter room/date, print/export | Reconciled totals, selected filters and unchanged stock |
| Audit | Read `/api/admin/audit` as admin or use account audit UI where available | Actor, action, entity and time for critical mutations; no credentials |

- [ ] All rows exercised successfully. Record sample IDs/totals in your private
  verification notes, not in a public issue or repository.
- [ ] Pending activity-planner design review remains tracked separately; record
  any behavior that blocks the actual pilot instead of marking it accepted.

## Failure and recovery exercise

- [ ] With synthetic data and no other users, stop only the `db` service through
  Docker Desktop. A read/save reports a usable unavailable/retry error. No false
  saved state, cleared valid session, or empty-success response occurs.
- [ ] Start `db` again. Retry an appropriate read; reconcile any uncertain write
  before retrying. Confirm the app recovers and status becomes healthy.
- [ ] Invalid input gives a readable field message without changing records.
- [ ] An internal error log identifies the request/category, without cookies,
  passwords, connection URLs, SQL values or names from private records.
- [ ] Create a backup. All coverage flags become `true` after the full synthetic
  exercise. Run `verify`; every table definition/count/content comparison passes.
- [ ] Copy the complete backup to a separate encrypted location. Verify that copy
  using a replacement/test host procedure, not just an archive listing.
- [ ] Run `recover`, reconcile the table above, and confirm previous databases are
  retained and old sessions no longer grant access. Record time to recover and
  the recovery point (how much later work would need reconciliation).
- [ ] Schedule and manually trigger the Windows backup task. Its result is 0 and
  a new complete backup appears. Confirm the sign-in/awake/Docker prerequisites.
- [ ] Perform an update and a rollback exercise during the synthetic pilot. Check
  matching release/database selection and preserved records after both.

## Completion

SKAO-30 remains open until runtime evidence is recorded, blocking findings are
resolved, docs match the chosen host, and an administrator accepts the pilot.
Do not treat generated test files, unrun CI, a successful image build, or a backup
without a verified restore as completed acceptance.
