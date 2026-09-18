# Staff directory — SKAO-24

Staff records contain a person's name, job role, active status and optional room assignment. Open **Staff** from the sidebar. Administrators can add, edit, deactivate and reactivate records. Editors and viewers can read and filter the directory.

## Using the directory

- Select **Add staff**, enter **Full name** and **Job role**, optionally select a room, and select **Save staff**. Names and job roles must be 1–100 characters after trimming. A job role is free text such as Teacher, Cook or Director.
- The default view shows active staff. Choose **Inactive** or **All statuses** to find deactivated records. Search by name and select **Search**; combine it with the room and status filters. **Unassigned** finds people without a room. Reset filters returns to the active directory.
- Select **Edit** to change a record. Select **Deactivate** and confirm to remove someone from the active total. Their record, ID and existing room reference remain available. To reactivate, edit the inactive record and check **Active staff member**.
- Newly assigned rooms must be active and configured. Existing assignments to archived rooms remain visible and editable. To reactivate an inactive person assigned to an archived room, select an active room or Unassigned.
- The count above the directory is the active total across all rooms and pages, regardless of the current filters. The Dashboard **Active Staff** card reads the same database count when the dashboard is opened or refreshed. Zero staff records means a count of zero.
- If another administrator changes the same record, saving reports a conflict. Typed edits remain in the form. **Reload staff record** asks before replacing those edits with current details; review and save again.
- **Refresh staff** reloads staff and room choices while preserving an open form. Errors offer a retry instead of presenting a failed load as an empty directory.

## Staff and login accounts

Staff and Accounts are separate. Creating a staff record never creates a username, password, session or permission. Entering `admin` as a job role does not grant administrator access. Deactivating a staff record does not disable an existing login; manage sign-in access explicitly under **Accounts**.

Staff records are not automatically imported from Accounts. Existing accounts do not provide authoritative staffing or room information. Add actual staff through this directory.

## API contract

Every endpoint requires an operational signed-in session. Mutations also require administrator access, an allowed Origin and the existing CSRF token.

| Method and path | Result |
| --- | --- |
| `GET /api/staff` | `{ items, total, activeTotal, page, pageSize }` |
| `GET /api/staff/:id` | `{ data: staffMember }` |
| `POST /api/staff` | `201 { data: staffMember }` |
| `PUT /api/staff/:id` | `200 { data: staffMember }` |

There is no delete endpoint. Use `PUT` with `active: false` and the current `version`.

Create accepts `name`, `role`, `active` (default true), and `roomId` (default null). Update accepts any nonempty subset of those fields **plus the current integer `version`**. IDs, timestamps and account-related fields cannot be supplied as editable data. Unknown fields are rejected. Each successful update increments the version. Stale writes return `409` with error code `STAFF_CONFLICT`.

Example create body using synthetic data:

```json
{ "name": "Synthetic Teacher", "role": "Teacher", "active": true, "roomId": null }
```

Example deactivation body, when the last loaded version was 2:

```json
{ "active": false, "version": 2 }
```

The returned staff member includes `id`, `name`, `role`, `active`, `roomId`, `version`, `createdAt`, `updatedAt`, and `room` (null or `{ id, name, active }`). Clients should display the persisted room name and retain its ID.

| Query parameter | Behavior |
| --- | --- |
| `q` | Name search, up to 100 characters; case insensitive; all supplied words must match. `%` and `_` are literal characters. |
| `active` | `true` (default), `false`, or `all` |
| `roomId` | A persisted room ID, or `unassigned`; omit for all rooms |
| `page` | Whole number, 1–1,000,000; default 1 |
| `pageSize` | Whole number, 1–100; default 50; UI uses 25 |

`total` counts all matching records before pagination; `activeTotal` always counts active staff across the facility. Invalid bodies/filters return 400, missing records or rooms 404, restricted writes 403, and archived-room assignment or stale-version conflicts 409.

## Persistence and scope

Migration `008-staff-directory` adds `StaffMembers`, with a foreign key to Rooms, timestamps, version and lookup indexes. It creates no staff or account seed data and changes no earlier migration. Restarting the PostgreSQL-backed server preserves staff records. Mock mode is intentionally temporary and resets with its process.

Staff mutations share the room transaction lock with room archival and record attributed `staff.create` / `staff.update` audit events. An audit-write failure rolls back the mutation.

This story does not add staff attendance, shift schedules, payroll, employment documents or account linking. It does not alter saved meal plans or their manually entered staff counts. A current staff roster is not a count of staff eating a particular meal. Other dashboard metrics remain under SKAO-28.

Regression coverage is provided in `server/tests/staff.test.js`, `server/tests/staff.postgres.test.js`, `client/src/pages/Staff.test.tsx` and `client/tests/browser/staff-directory.spec.ts`. Use the shared [backup, migration and automated checks procedure](update-checks.md).

## Manual verification

1. As an administrator, create a synthetic staff member, edit their role and assign an active room. Reject blank required fields. Refresh Chrome and restart the backend to check persistence.
2. Search and filter, deactivate, then reactivate the person. Verify the facility-wide active count, including across pages, and the Dashboard Active Staff count. Meal-plan headcounts and login accounts must stay unchanged.
3. Archive the assigned room. Existing details should remain editable, but new assignments and reactivation require an active room or Unassigned.
4. Save conflicting edits from two tabs; verify the stale form retains its values until **Reload staff record** is confirmed.
5. Verify editors and viewers can browse but cannot add, edit or deactivate staff. Deactivate synthetic staff when finished.
