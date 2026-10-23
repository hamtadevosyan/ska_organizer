# Assigned class access (SKAO-111)

The **Class viewer** preset uses the existing internal `viewer` role. Administrators assign exactly one active class in Accounts. Assignment is explicit; employee names, usernames and job titles do not determine access. An account without an assignment, or whose class is archived or missing, sees a neutral empty state.

Class viewers see their class overview, active children's basic names, that class's saved weekly activities and saved shared academy meal names. Meal plans currently apply to the facility; the class screen labels that scope. It does not claim to provide an individual child's diet or allergy clearance.

The class area excludes child profiles, dates of birth, family contacts, health information, documents, employee records, inventory, purchasing, reports and planning actions. All legacy operational routes return `403 CLASSROOM_ONLY`, including GET/HEAD generation, previews and direct API requests. Hiding navigation is only a presentation aid; the server enforces the boundary.

## Account administration and rollout

Open **Accounts**, create or manage an account, choose **Class viewer**, and select an active class or **No class assigned**. Empty assignment is valid and grants no class records. Archived assignments remain visible to the administrator as unavailable, so a failed room lookup cannot silently change access. Changing role, assignment or enabled status revokes that account's sessions. A display-name-only edit retains sessions.

Migration `024-classroom-account-scope` adds the nullable assignment, a room foreign key and a constraint restricting assignments to viewer accounts. It revokes all existing viewer sessions once; the next live authorization check signs them out and clears previously loaded broad application state. It preserves administrator/editor sessions, passwords and domain records. It does not infer assignments. Repeated migration runs are no-ops.

## API contract

The API uses the session account's live assignment. Caller-supplied room IDs, headers and bodies cannot widen it. Unknown query parameters are rejected. The service rechecks authorization under authentication then room locks, so a waiting request cannot retain an old assignment. Responses are not cached.

| Read endpoint | Projection |
|---|---|
| `GET /api/classroom` | `state`, public room configuration, facility date/time zone and active child count |
| `GET /api/classroom/children` | Active assigned-class children: `id`, `firstName`, `lastName`, `preferredName`; all matching records |
| `GET /api/classroom/activities?weekStart=YYYY-MM-DD` | Saved assigned-class week, version and time entries with activity name, description and duration |
| `GET /api/classroom/meals?weekStart=YYYY-MM-DD` | Saved facility week, version and weekday meal names/types/slots; `scope: facility` |

Weekly queries require a Monday date. Missing saved plans return `hasPlan: false` and empty entries; reading never generates a plan or consults legacy draft defaults. No recipe, count, inventory or shopping fields are projected. HEAD has the same authorization as GET. Non-read methods are denied. Administrator/editor accounts use their existing operational screens rather than these class-account projections.

The client clears class data during scope changes, refreshes, authorization failures and outages. It aborts obsolete requests and rejects responses for a different class. Focus, visibility and periodic checks refresh live access. Old management links redirect before management components mount. Signing out clears the protected view.

## Verification

Run `bash scripts/check-update.sh --access` after stopping normal servers. It backs up and migrates before running the focused checks. Run `bash scripts/check-update.sh` before merging. Test two synthetic classes and verify each viewer cannot see the other's names or activities, old management links redirect, and reassignment signs the viewer out. Confirm unassigned and archived classes reveal no records and administrator/editor workflows remain available.

Facility-wide read-only, time-clock-only access and badge authentication are proposed separately in [Staff access design](staff-access-design.md). They are not granted by this preset.

## Teacher extension

The separate Teacher role may use these saved class projections and adds scoped attendance and reviewed safety cards. Class viewer permissions remain unchanged. See [Teacher care access](teacher-care-access.md).


## Teacher and class-viewer presentation

My class shares the administrator Home palette, action cards and existing public illustration. Teacher shortcuts open scoped class attendance, class children, saved activities and meals. Class viewers receive class children, saved activities and meals. Staff work attendance uses the separate registered PIN station; classroom attendance for children remains teacher-only. The welcome and detail cards use their current class assignment; no global dashboard request, staff/private payroll shortcut or additional child fields are introduced. Attendance and health/emergency actions remain teacher-only and server-authorized. No personal data is added to offline caches.
