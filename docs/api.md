# API index

In the Windows pilot, all requests use the same trusted HTTPS origin as the page,
for example `https://localhost:8443/api/...`. PostgreSQL and Node have no published
host port. Ubuntu development uses the configured VM API URL.

## Session contract

`POST /api/auth/login` accepts a JSON username/password and returns the public
account and CSRF token, setting an HttpOnly session cookie. Production cookies
are Secure and SameSite=Strict. Use `GET /api/auth/session` to read the current
account/token. `POST /api/auth/logout` and `POST /api/auth/password` require the
session, exact allowed `Origin`, JSON content type and `X-CSRF-Token`.

Operational writes require the same session/CSRF/Origin checks. Class viewer accounts
can use only the dedicated assigned-class projections; legacy operational reads, previews and generation are also denied. Account, room and staff administration have
additional role restrictions. The authentication guide is the maintained source
for these rules. Do not put a password, session cookie or CSRF token in a URL.

| Area | Main routes | Maintained contract |
|---|---|---|
| Health | `GET /api/health`, `GET /api/ready` | Process/storage status only; no account or record data |
| Accounts/audit | `/api/auth/*`, `/api/admin/accounts`, `/api/admin/audit` | [Authentication](authentication.md) |
| Class viewer | `/api/classroom`, `/api/classroom/children`, `/api/classroom/activities`, `/api/classroom/meals` | [Class access](classroom-access.md) |
| Teacher care | `/api/classroom/attendance`, `/api/classroom/children/:id/safety`, scoped attendance actions; `/api/children/:id/safety` for admin/editor | [Teacher care access](teacher-care-access.md) |
| Dashboard | `GET /api/dashboard` | [Dashboard](dashboard.md) |
| Rooms | `/api/rooms`, `/api/rooms/:id` | [Rooms and classes](rooms-and-classes.md) |
| Children | `/api/children`, `/api/children/:id/profile` | [Child roster](child-roster.md) |
| Attendance | `/api/attendance/daily`, `/api/attendance/checkin`, `/api/attendance/:id/checkout` | [Daily attendance](daily-attendance.md) |
| Staff | `/api/staff`, `/api/staff/:id` | [Staff directory](staff-directory.md) |
| Meals/recipes | `/api/meals`, `/api/ingredients`, `/api/meals/:mealId/ingredients` | [Catalog corrections](catalog-corrections.md) |
| Saved meal plans | `/api/menu/plans/:weekStart`, `/api/menu/plans/:weekStart/shopping` | [Saved weekly menus](saved-weekly-menus.md) |
| Stock/purchases | `/api/inventory`, `/api/inventory/groups`, `/api/inventory/:id/movements`, `/api/inventory/:id/purchases` | [Inventory](inventory.md) |
| Activities/schedules | `/api/activity`, `/api/schedule/plan` | [Activity planner](activity-planner.md) |
| Reports | `/api/reports/config`, `/api/reports/attendance`, `/api/reports/purchases`, corresponding `.csv` routes | [Reports](reports.md) |

## Errors and diagnostics

Do not assume every route uses the same success envelope; use each feature's
contract. Validation errors generally include `error.message` and may include
`fields`/`code`. A 401 means the session must be re-established; 403 means the
request is not permitted. A version/idempotency conflict must be reconciled rather
than blindly retried. A database connection outage returns 503 with a readable
message, code `DATABASE_UNAVAILABLE`, and `Retry-After: 5`. A generic internal
error is 500 without exception contents. A failed health/storage probe returns
only `status: unavailable` with 503.

Each API response includes a generated `X-Request-Id`. An internal-error log
records that ID, method, status and category. Report that ID when diagnosing an
error; do not attach credentials or raw private request bodies. Read-only health
probes do not bypass authorization on any operational route. Responses use
`Cache-Control: no-store`.

### Linked staff accounts (SKAO-111)

Administrator account create/update accepts nullable `staffMemberId`. Responses include `staffMemberId` and minimal `linkedStaff` (`id`, `name`, `active`, `roomId`). A linked Teacher or Class viewer derives `roomId` from Staff; contradictory supplied classes are rejected. Another account cannot reuse the same employee. Unlink explicitly with `staffMemberId: null`.

`GET /api/admin/staff-options` returns all employees (including inactive) with `id`, `name`, `jobRole`, `active`, `roomId`, `roomName` and nullable minimal linked `account` (`id`, `username`, `role`, `disabled`). It is administrator-only and excludes passwords, sessions, files and clinical details. Staff class/status updates synchronize linked accounts and revoke sessions in the same audited transaction. See `docs/staff-account-links.md`.

### Staff time and private payroll (SKAO-106)

Personal `GET`/`POST /api/time-clock` routes now return 403. Admin/editor clock actions use `GET /api/work-time/clock` and `POST /api/work-time/staff/:id/clock`. The registered PIN station uses separate `/api/station-clock/*` device authentication and CSRF, with administrator-only `/api/clock-stations/*` setup. See [Clock station](time-clock-station.md) for the complete contract. Employee identity, timestamps, version checks and audited writes are enforced by the server.

All `/api/payroll/staff/:staffId` operations require an administrator and a configured payroll encryption key. GET returns a masked private profile, rates, ledger/decisions, document metadata and snapshot summaries. POST subroutes: `profile`, `rates`, `corrections`, `approvals`, `preview`, `snapshots`, `documents`. Profile/rate writes use profile version; corrections/approvals use ledger version; file revisions use document version. Changes require a reason. The corrections endpoint preserves historical `breaks` unchanged when the optional field is omitted. Only completed historical unpaid entries contribute deductions; unfinished entries do not mark a day incomplete. Preview accepts start/end dates; snapshots also require the current calculation fingerprint and a UUID requestId. GET `snapshots/:id` returns the historical result plus sourceChanged. GET `documents/:id/:revision` authorizes and audits an attachment download. Read responses are no-store. Missing/wrong/insecure encryption keys return 409 `PAYROLL_LOCKED`; stale versions return 409 `PAYROLL_CONFLICT`. See [payroll.md](payroll.md) for rule boundaries and key recovery.


`GET /api/work-time` is the administrator/editor operational projection for approved staff schedules, actual clock times and recent work-time exceptions. Optional start/end dates cover at most 93 days; the default covers the last 60 days. POST `/api/work-time/staff/:staffId/schedule` accepts version, effectiveOn, startTime, endTime and reason (legacy approvedHours remains accepted alone); effective dates cannot precede today. POST `/api/work-time/staff/:staffId/review` accepts the ledger version, date, reason and decision (`worked` or `clock-error`). A clock-error also needs workEndedAt, optional DST occurrence and noWorkAfterEnd=true. Clock changes preserve originals/audit history, and return conflicts for stale versions. These endpoints require current admin/editor authority and CSRF on writes. They do not grant payroll profile/file/rate access. All responses are no-store.


### Approved work windows

`POST /api/work-time/staff/:staffId/schedule` accepts `{version,effectiveOn,startTime,endTime,reason}` for same-day facility-local `HH:mm` times, with end after start. Legacy `{approvedHours}` requests remain compatible but cannot be mixed with window fields. `GET /api/work-time` exposes the approved window separately from actual `checkin`/`checkout`, duration, early/late/outside-window time and review status. Its chronological `sessions[]` projection contains `{id,start,end,dayStart,dayEnd,dayMillis,originalStart,originalEnd}`: `start`/`end` are actual full timestamps, `dayStart`/`dayEnd` are the overlap with the selected facility date, and `originalStart`/`originalEnd` retain the original punches before corrections. An open session has a null actual end; an earlier day’s clipped overlap can still end at midnight. `dayMillis` supplies the raw overlap duration without implying a checkout. The private day review includes the same projection; clients display dates and separate sessions instead of pairing clock-only endpoints. The first clock event freezes the day's effective window in the existing encrypted ledger. Only admin/editor can access this projection or save schedules/reviews; private rates, identifiers and payroll files remain administrator-only. No automatic deduction or time cap is introduced.

Private administrator `GET /api/payroll/staff/:staffId` includes a computed `ledger.days[].review` with `state` (`awaiting-approval`, `needs-attention`, or `approved`), `reasons` (`code`, plain-language `message`, action destination, and optional affected `date`), `canApproveRecorded`, and an optional `workTime` comparison of the frozen schedule and actual clocks. This is a read-only explanation projection, not a new stored approval or payroll calculation. Reasons use the current calculator validation; authorization and no-store behavior remain in place. Operational editors and employee accounts cannot access this private endpoint.


### Manual paid-time decisions and weekly short-day warnings

New `POST /api/payroll/staff/:staffId/approvals` decisions use `mode: "manual-reviewed"`, integer `paidMillis`, integer `rateMillis` (the portion of paid time at the selected rate), integer `multiplierHundredths` (100 = 1×, 150 = 1.5×; range 100–1000), `overtimeReviewed`, `rulesReviewed`, reason, date, ledger version, current `profileVersion`, and decision status. Both allocation fields must be supplied together; `rateMillis` must be between zero and `paidMillis`. The remaining paid time uses the effective ordinary hourly rate. A rate/profile change between loading and saving returns a conflict instead of accepting a stale decision. No factor or overtime allocation is selected automatically. Legacy `premiumCents` requests remain a separate compatibility path and cannot be mixed with new allocation fields; stored legacy decisions retain their original arithmetic. Replacing a previously nonzero fixed premium requires `replaceLegacyPremium: true`. Rate allocations are bound to their reviewed source data, and a changed source blocks fresh finalization until reviewed again. Existing simple legacy approvals remain readable; old nonzero overtime/double-time allocations require explicit manual review before a fresh calculation. Historical snapshots are retained unchanged.

Private daily review summaries include `suggestedPaidMillis`, `roundingCreditMillis`, `scheduledCreditMillis`, `requiresRoundingReview`, `shortDayOrdinal` and `requiresOvertimeReview`. Completed fractional work proposes the next whole paid hour, never less than actual work; open days and exact whole hours are unchanged. The first completed short day of the configured week has no rounding warning only when the rounded amount matches its captured approved window and all actual work is inside it. Later short days require rounding review. `ROUNDING_REVIEW` reasons explain the proposal directly; an explicit administrator approval with `rulesReviewed: true` records the rounding decision and its current fingerprint. Old approvals needing review and saved snapshots are not rewritten by reads. Higher previously approved manual paid credits, additional pay and adjustments are preserved on reapproval. Actual clock timestamps remain unchanged.

Approvals accept `hoursOverride: true` when the administrator intentionally chooses paid time different from the current proposal. The existing `reason` is required. An amount below recorded paid time also requires `clockErrorConfirmed: true`. A current override allows higher or lower paid amounts without rewriting source clocks; its stored flags, attributed before/after record and `hoursOverrideFingerprint` bind the reviewed decision to actual sessions, schedule, effective rate, rules and relevant workweek context. Stale overrides cannot finalize. Incomplete days still require an actual checkout, and overrides never waive explicit overtime review or unresolved outside-schedule review.

`POST /api/payroll/staff/:staffId/corrections` also accepts `endLocal: "YYYY-MM-DDTHH:mm"` in the ledger's time zone, with optional `endOccurrence: "earlier" | "later"` when daylight-saving time repeats. Supply the existing start/session ID, current ledger version, reason and `voided: false`; do not mix `endLocal` with `end`. Future, nonexistent, ambiguous without a choice, before-start or overlapping times are rejected. Omitting `breaks` preserves legacy arrays. Original clock values and correction history are retained.

Administrator projections include `shortDayWarnings` with staff identity, configured week boundaries, count and actual dates starting on the second completed short day. A later short day does not retroactively invalidate the first qualifying day's rounding decision. `GET /api/work-time` also supplies an administrator-only `overtimeReviewCount`; editor work confirmations cannot clear a pending administrator pay review. Station responses expose only the identified employee and current clock action; personal clock responses are disabled.
