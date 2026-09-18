# Rooms and classes — SKAO-21

## What changed

- The Rooms & Classes page at `/rooms` lists persisted rooms, their age ranges, configured capacities, active status and assigned-child counts.
- Administrators create, edit, archive and reactivate rooms. Editors can assign existing children; read-only accounts can view rooms and counts.
- Ages are entered as whole months, from 0 to 216. Minimum age cannot exceed maximum age. Capacity is a positive integer. These capacities are operational settings, not a determination of licensing compliance.
- An assignment that would exceed capacity returns a warning and requires explicit acknowledgement before it is saved. Transfers and removal of assignments update the counts. After SKAO-22, counts include all actively enrolled assigned children, regardless of pagination. Ending enrollment frees the place while preserving the room reference.
- Archived rooms remain available for history. Existing child assignments, attendance, activities and schedule records remain attached. New child assignments, new activity room assignments, check-ins and schedule writes to archived rooms are rejected.
- A child or activity already assigned to an archived room can keep that same reference while other details are edited. Children can be moved out of archived rooms, and existing attendance can be checked out.
- The Activity Planner and existing `/schedule` page load room choices from the database. The schedule page also supports viewing archived-room history.

The child API previously read a separate in-memory demo store. It now uses the configured database adapter, including the existing Children table, with a nullable current `roomId`. This change does not import hardcoded demo children or demo enrollments. The Children page and enrollment lifecycle are documented in [child-roster.md](child-roster.md).

The existing schedule page depended on missing service/adapter methods. This change supplies the minimum room-aware persistence and validation needed by that page. The full activity planning story remains SKAO-27.

## Migration 005

Run `npm run db:migrate` from `server` before starting the updated backend.

The additive migration creates Rooms, adds Children.roomId, supplies the existing ScheduleEntries table when missing, and installs room foreign keys and lookup indexes. Existing rooms referenced by attendance, activities or older schedule records are preserved as inactive imported rooms.

Imported rooms have unknown age ranges and capacity. In Rooms & Classes, enable **Show archived rooms**, edit each imported room, enter its real settings, and activate it when appropriate. The migration does not invent age ranges or capacity.

Archiving updates `active`; there is deliberately no room deletion endpoint. Foreign keys prevent deleting referenced rooms directly.

No dependencies or environment variables were added. Keep the PostgreSQL and authentication configuration from SKAO-20.

## API

All routes require the existing authenticated session. Mutations require the existing allowed Origin and CSRF token.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/rooms` | Active rooms with counts |
| GET | `/api/rooms?includeArchived=true` | Active and archived rooms |
| GET | `/api/rooms/:id` | One room with counts |
| POST | `/api/rooms` | Administrator creates a room |
| PUT | `/api/rooms/:id` | Administrator updates supplied room fields |
| GET | `/api/rooms/:id/assignment-preview?childId=...` | Current and proposed counts for an existing child |
| PUT | `/api/children/:id/room` | Editor/administrator assigns, transfers or unassigns a child |
| GET | `/api/rooms/:id/present-children?date=YYYY-MM-DD` | Children present on the selected date, including historical rooms |

Room fields:

~~~json
{"name":"Sunflower","ageMinMonths":24,"ageMaxMonths":60,"capacity":12,"active":true}
~~~

Assignment:

~~~json
{"roomId":"SAVED_ROOM_ID"}
~~~

A capacity warning is HTTP 409 with `error.code = "ROOM_CAPACITY_WARNING"`. After acknowledging the displayed warning, submit `confirmOverCapacity: true`. Unassign using `roomId: null`. Unknown rooms return 404; new assignments to archived rooms return 409 with code `ROOM_ARCHIVED`.

The existing POST/PUT child routes also accept `roomId` and `confirmOverCapacity`, and apply the same assignment rules. The existing child list response stays `{items,total,page,pageSize}` and accepts `q`, `roomId`, `page`, and `pageSize` (1–200).

Room responses use `{data: ...}`. Fields include `assignedChildCount`, `availablePlaces`, `overCapacity`, and `needsConfiguration`.

Schedule writes validate the selected Monday, supported time blocks, dates within that week, duplicate slots, and activity availability for the room. Room archival and assignment checks are serialized inside the same database transaction as each write and its audit.

## Verification supplied

- `server/tests/rooms.test.js`: room lifecycle and validation, capacity preview and acknowledgement, transfers, pagination-independent counts, simultaneous assignments, archival, permissions, audit rollback, and room-specific scheduling.
- `server/tests/rooms.postgres.test.js`: migration of historical references and persistence across database reconnects.
- `client/src/pages/Rooms.test.tsx`: form validation, archival, read-only access, retained archived selections, capacity acknowledgement and database room selection.
- `client/tests/browser/rooms.spec.ts`: room creation/editing/reload, Activity Planner selection and archival.
- Existing attendance/present-children fixtures now create real referenced rooms and children.

## Manual verification

Use the shared [backup, migration and automated checks procedure](update-checks.md), then verify the workflow with synthetic records in Windows Chrome:

1. Create and edit a room with ages 24–60 months and capacity 1. Verify blank names, reversed ages and zero/fractional capacity are rejected.
2. Assign two active children, acknowledging the capacity warning for the second. Transfer or unassign one and check both room counts.
3. Select the room in Activity Planner and the schedule. Archive it and confirm existing references remain, while new assignments are rejected. Reactivate it.
4. Refresh Chrome and restart the backend; room details and assignments should persist.
5. Verify administrators can manage rooms, editors can assign children, and read-only accounts see no write controls.
