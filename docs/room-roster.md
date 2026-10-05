# Room rosters — SKAO-48

In **Rooms & Classes**, choose **View children** on a room card. Its roster opens
at `/rooms/ROOM_ID`, so refreshing or reopening that URL keeps the same room.
Archived rooms can also be viewed through **Show archived rooms**.

The summary shows the room name, active assigned-child count and configured
capacity. It uses the existing saved room summary; searching, pagination and
including inactive children do not change occupancy. Inactive children retain
their room reference and are excluded from the active count.

The list defaults to active enrollment. **Include inactive children** explicitly
adds retained inactive records, labeled **Inactive**. **Search children** searches
first, last and preferred names within this room. The roster shows 25 records per
page and provides **Previous** / **Next** controls. Names, preferred names, birth
dates and enrollment status help distinguish similarly named children.

**View profile** opens the existing child profile by its saved ID, including
notes and recent attendance. **Back to room roster** returns to the same room and
filters with freshly loaded assignments. **Back to rooms** opens Rooms & Classes.
Refreshing the browser resets the temporary search/include-inactive filters to
their active-enrollment defaults while preserving the selected room URL.

To change assignments or enrollment, use the existing **Children** page or room
assignment controls. Returning to a room, choosing **Refresh roster**, closing a
profile or returning focus to the app reloads the summary and roster. Transfers,
ended enrollment and reactivation use the existing room availability and capacity
rules; this page adds no enrollment writes or new edit permissions.

While a request is pending, its previous rows are hidden. Switching rooms resets
the previous room's data and profile immediately; canceled/late responses cannot
replace the selected room's result. Loading failures hide the previous records
and occupancy summary and provide **Try again**. Empty rooms and empty search
results have separate messages. Room and roster loading both must succeed before
records are displayed.

## Access and data

The new route stays behind the existing application sign-in gate. Administrators,
editors and read-only accounts can review permitted rooms and child profiles.
The APIs enforce the existing authenticated session and write roles. Read-only
accounts receive no editing controls or additional permissions.

The page reuses `GET /api/rooms/:id`, the filtered child-roster API and the existing
profile API. API responses retain `no-store` protections. Operational records,
searches and profile selections stay in React memory; the static-only service
worker does not cache these APIs. No dependency, environment variable or database
migration is added by this story. Existing migrations, including SKAO-43 migration
015, must already be applied through the normal update procedure.

## Verification

- `server/tests/roomRoster.test.js`: room isolation, active occupancy, preferred
  search and pagination, inactive inclusion, same-name profiles, transfers,
  ending/reactivating enrollment, retained history and API authorization.
- `client/src/pages/RoomRoster.test.tsx`: filters/counts, profile identity and
  historical room labels, canceled requests, failure/retry, lifecycle refresh,
  pagination correction and read-only viewing.
- `client/tests/browser/room-roster.spec.ts`: the complete flow at 390px and
  1280px, refresh/reload, empty rooms, duplicate names, occupancy changes,
  outage recovery and usable mobile widths/touch targets.

Use the shared [update checks](update-checks.md), then verify synthetic records
on desktop and iPhone/iPad: open empty/populated/archived rooms, search preferred
names, include inactive records, view distinct same-name profiles and return,
transfer/end/reactivate enrollment and refresh both affected room rosters. Verify
a read-only account can view the flow and cannot edit records. Restart the native
backend and reopen the room URL to check saved assignments and counts.
