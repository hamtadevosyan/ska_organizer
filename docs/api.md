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
