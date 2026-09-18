# Daily attendance — SKAO-23

Open **Attendance** in the sidebar. Administrators and editors can record arrivals, departures and corrections. Viewers can read attendance and correction history. These are the existing account roles; no self-service teacher or parent sign-in workflow is added.

## Record attendance

1. Select a room or **All rooms**. The initial date is today at the facility.
2. Today lists active children assigned to the room, plus recorded visits and unresolved older visits. Search by a child's name or preferred name.
3. Select **Check in** when the child arrives. The server records the current time and the signed-in account. The child changes to **Present**.
4. Select **Check out** for the open visit when the child leaves. The child changes to **Checked out**. A later arrival creates a separate visit.
5. Use **Refresh attendance** to read updates from another device. Attendance is not automatically polled.

Assign unassigned children to an active, configured room through **Children** before checking them in through this screen. An open visit remains visible after a child's room, enrollment or the room's active status changes, so it can still be checked out. Visits retain their recorded room. **View profile** opens the child's existing profile.

Repeated or concurrent check-ins cannot create two valid open visits for one child. Repeated checkout returns the original departure time. Browser retries retain a request identifier until a successful response; replaying it after checkout returns the earlier record rather than opening another visit. Failed actions display an error and do not optimistically change attendance.

## Dates and facility time

Set this in `server/.env` and restart the backend:

~~~dotenv
FACILITY_TIME_ZONE=America/Los_Angeles
~~~

This is also the default. Use the facility's IANA time-zone name. Windows, Ubuntu and other browsers may have different local zones; attendance dates, timestamps, correction inputs and child-profile attendance all use the configured facility zone. An invalid zone stops backend startup with a configuration message.

Selecting an earlier date shows recorded visits overlapping that facility day, including children who later moved rooms or ended enrollment. It does not reconstruct an unrecorded historical roster. A visit that ends exactly at midnight belongs to the preceding day; a visit starting at midnight belongs to the new day. Daylight-saving days use their actual 23-hour or 25-hour boundaries.

Use today's view for live arrival/departure actions. A request using an older facility date is rejected with instructions to refresh. Historical corrections are available through recorded visits; there is no retrospective creation form in this release.

## Corrections and legacy records

Select **Correct / history**, review the current record, edit its room or times, explain why it changed, and confirm **Save correction**. Times entered in the form are facility-local times. During the fall clock change, choose the first or second occurrence when prompted. Nonexistent spring-forward times are rejected.

Every correction stores the original and resulting values, reason, acting account ID and username, and correction time. These values are written in the same transaction as the attendance change and the audit event. A stale version, overlapping visit, future timestamp, departure before arrival, or missing reason is rejected. After a conflict, your typed correction remains in the form; use **Reload current record** to deliberately discard it and read the latest record.

Use **Void mistaken or duplicate visit** to exclude an erroneous visit from counts while retaining its times and history. Uncheck it and give a reason to restore a verified visit; normal overlap/time checks still apply. There is no destructive attendance-delete API.

Migration `007-daily-attendance` preserves existing records. Duplicate open visits, missing arrival times and reversed time ranges are marked **Needs review**. No departure time is invented. Reconcile mistaken duplicates by voiding them first, then correct the real visit using a reliable record of arrival/departure. Older open visits also appear for review today. The displayed present count summarizes open visits; review unresolved visits before relying on it.

The migration adds versioning, retry identifiers, review/void flags, correction history, lookup indexes, a valid-time constraint and a partial unique index for valid open visits. Existing migrations 001–006 remain unchanged. New writes cannot bypass the database's open-visit constraint. Existing flagged records remain available for correction.

## Use attendance in the meal planner

1. Select the week containing today and generate or reopen its menu.
2. Select **Review today's attendance count**. The count is children currently checked in across all rooms at the displayed time; it is not the total who attended earlier and already left.
3. Review the number, then select **Apply count to YYYY-MM-DD only**. An unresolved open visit from an earlier day or an invalid record blocks the sample until reviewed.
4. Only that day's child count changes. Weekly default children, staff and all other days remain separately editable. **Use weekly default** removes a daily override.
5. Shopping quantities recalculate from each day's child count plus staff. Select **Save Menu** to persist the draft and its daily counts together. Reopening a saved plan restores them.

Attendance is a deliberate snapshot and does not silently rewrite a saved menu or update as children arrive/leave. Read it again when you want a newer count. Zero children is valid for a daily override. Today must be a weekday included in the selected menu; future weeks and weekends cannot import today's attendance. Future-week counts can still be typed manually. Printed shopping lists identify daily overrides.

## API

Attendance responses use the existing raw object/array format, without a `data` envelope. All endpoints require a valid session; mutations also require an allowed Origin, CSRF token and admin/editor role.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/attendance/config` | Facility `timeZone`, `today`, `serverNow` |
| GET | `/api/attendance/daily?date=YYYY-MM-DD&roomId=ID` | Roster, visits, open visits, actions, available rooms and counts; omitted date means today, omitted room means all |
| GET | `/api/attendance?date=YYYY-MM-DD&roomId=ID&childId=ID` | Filtered visit records, including voided records for history |
| GET | `/api/attendance/:id` | One visit, including its version and review/void flags |
| POST | `/api/attendance/checkin` | `{ childId, roomId, date?, requestId? }`; 201, including idempotent retries |
| POST | `/api/attendance/:id/checkout` | `{ date?, version? }`; returns the recorded checkout unchanged on retry |
| GET | `/api/attendance/:id/corrections` | Read-only before/after history |
| PUT | `/api/attendance/:id/correction` | Required `version` and `reason`; optional `roomId`, `checkIn`, `checkOut`, `voided`, `checkInOccurrence`, `checkOutOccurrence` |
| GET | `/api/attendance/today-headcount` | `{ date, timeZone, takenAt, childrenCount }`; 409 when open attendance requires review |

`requestId` is an optional 16–100 character alphanumeric, underscore or hyphen identifier. The UI uses 32 random hex characters. It is bound to the original child, room and acting account. Client-supplied `recordedBy` is ignored; the server uses the session account.

Correction timestamps accept ISO instants with an explicit offset (for example `2026-09-08T09:00:00-07:00`) or facility-local `YYYY-MM-DDTHH:mm[:ss]`. Occurrence is `earlier` or `later`. Use `checkOut: null` for an open visit. Child identity cannot be changed by a correction.

The dated weekly-menu preview accepts optional `dailyChildrenCounts: { "2026-09-08": 12 }`. Keys must be weekdays within that plan's week; values must be non-negative safe integers. Saved snapshots and shopping metadata retain the map. Existing callers without it retain weekly-default behavior.

## Supplied coverage

- API: room/date rosters, repeated/concurrent actions, retry keys, enrollment restrictions, correction history, invalid/stale times, overlaps, permissions, CSRF, audit rollback and headcount review blocks.
- PostgreSQL: legacy migration, unique/time constraints, history protection and reconnect persistence. The general API suite also runs against PostgreSQL using the existing test command.
- Time-zone helpers: UTC/local midnight, both DST transitions, impossible/repeated wall times and invalid configuration.
- Frontend: action status, retry handling, read-only controls, stale responses, correction failures, date-specific planner transfer and future-week isolation.
- Browser: real HTTP arrival, refresh, void/history and departure flow.

Use the shared [backup, migration and automated checks procedure](update-checks.md).

## Manual verification

Use synthetic children assigned to active rooms and check the displayed facility time zone.

1. Check a child in, refresh Chrome and restart the backend. The open visit should persist. Try the same arrival in two tabs; only one valid open visit may exist. Check out and confirm the departure persists.
2. Correct a completed visit with a reason. Verify before/after history, actor and time; reject blank reasons, future times, reversed times and overlaps. Try saving an older revision from a second tab and confirm typed edits survive the conflict.
3. Void a mistaken visit; it should remain in history and leave the counts. Moving the child or ending enrollment must preserve historical rooms and allow an existing open visit to be checked out. Verify read-only access and date/room/name filters.
4. On a weekday, review today's attendance in the current meal-plan week. Reviewing must not change counts; applying changes only today's child count and shopping quantities. Staff, other daily overrides and future weeks remain independent.
5. Save, reload and print the menu; confirm its daily counts persist. Check out the test children and verify the saved plan stays unchanged until a new count is explicitly applied. Review flagged legacy visits without inventing missing times.
