# Child roster and enrollment — SKAO-22

The **Children** page at `/children` maintains child profiles and room assignments. Administrators and editors can make changes. Read-only accounts can view the roster and profiles. All API routes use the existing sign-in, role, Origin and CSRF checks; successful writes record the acting account in the audit log.

## Profiles and enrollment

A new child requires first name, last name and a real date of birth. Names are trimmed and repeated whitespace is normalized. Dates must use YYYY-MM-DD and fall between 1900-01-01 and today (the API uses UTC). Preferred name, room and operational notes are optional. The form limits names to 100 characters and notes to 2000 characters. Unassigned children can remain actively enrolled while a room is selected later.

Use **View profile** to read notes and the ten most recent attendance records. Changing names, details or room keeps the same child ID. Earlier attendance keeps its original room reference.

Use **End enrollment** to make a child inactive. This preserves the profile, room reference and attendance history. Inactive children disappear from the default roster and the Rooms assignment dropdown, do not occupy room capacity, and cannot receive new check-ins. Existing attendance remains readable and open attendance can still be checked out.

To reactivate, filter Enrollment to **Inactive**, edit the child and select **Active enrollment**. Reactivation checks room availability and capacity again. If the former room is archived, choose an active room or Unassigned. There is no destructive delete control; DELETE requests to the children API return 405 with instructions to end enrollment.

## Finding children

The roster supports search by first, last or preferred name, room (including archived rooms and Unassigned), and Active / Inactive / All enrollment filters. It shows 25 children per page. The API defaults to 50 and permits up to 200 per page. Search and count queries apply the same filters. Room counts include all actively enrolled children, independent of pagination.

## Duplicate review and capacity warnings

When creating a child, or changing their first/last name to match an existing record, the server checks for the same normalized first and last name. Active and inactive matches are included. The form shows up to 20 matching records with birth dates and enrollment status. After reviewing them, check the acknowledgement and save to permit legitimate same-name children. A changed birth date or other detail clears the acknowledgement; a changed name clears the old matches. Duplicate review does not merge or overwrite another record.

An assignment that adds an active child to a full room requires a separate capacity acknowledgement. Reactivation counts as a new occupied place. The server rechecks under the room transaction lock so concurrent writes cannot silently bypass duplicate review or capacity warnings. Editing an existing child's details without changing their name or occupied room does not trigger repeated warnings.

## Database upgrade

Migration `006-child-enrollment` adds `Children.active` with default true and a lookup index. All existing children start active; review their real enrollment status after upgrading. Existing missing names/birth dates stay unknown. New records require these details, while partial updates such as ending enrollment do not invent missing legacy values. The full edit form asks for missing required details before saving.

The migration also protects attendance references to children against future invalid writes or deletion. The foreign key is added without validating old rows, because historical attendance can predate persistent child records. Such historical rows are retained; the migration does not fabricate children or remove attendance. Existing migrations 001–005 are unchanged.

## API

Responses retain the existing children API shape, without an extra `data` envelope.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/api/children?q=...&roomId=...&active=true&page=1&pageSize=50` | `{ items, total, page, pageSize }`; active defaults to true |
| GET | `/api/children?active=false` | Inactive roster |
| GET | `/api/children?active=all&roomId=unassigned` | All unassigned children |
| GET | `/api/children/:id` | Active or inactive child record |
| GET | `/api/children/:id/profile` | `{ child, room, recentAttendance }` |
| POST | `/api/children` | Create; returns 201 |
| PUT | `/api/children/:id` | Update supplied profile/enrollment fields |
| PUT | `/api/children/:id/enrollment` | Change `active`, with optional `roomId` and capacity confirmation |
| PUT | `/api/children/:id/room` | Assign an active child or remove a room assignment |
| DELETE | `/api/children/:id` | 405; end enrollment to retain history |

Allowed profile fields are `firstName`, `lastName`, `dateOfBirth`, `preferredName`, `notes`, `photoConsent`, `roomId`, and `active`. The small initial form does not add a photo-consent workflow; existing API values remain intact. Confirmation flags `confirmDuplicate` and `confirmOverCapacity` must be booleans and are not stored as profile data.

Invalid fields return 400 with `error.fields`. Duplicate review returns 409 with `error.code = CHILD_DUPLICATE_WARNING` and a limited `error.duplicates` array. Capacity review uses `ROOM_CAPACITY_WARNING`. Inactive enrollment restrictions use `CHILD_INACTIVE`; archived rooms use the existing `ROOM_ARCHIVED` response.

## Verification and scope

New coverage is supplied in `server/tests/childRoster.test.js`, `server/tests/childRoster.postgres.test.js`, `client/src/pages/Children.test.tsx` and `client/tests/browser/child-roster.spec.ts`. Existing room fixtures now supply birth dates and explicitly acknowledge intentional same-name synthetic children.

Run the automated and manual checks in [SKAO-22-manual-install.md](SKAO-22-manual-install.md). Final tests, PostgreSQL integration and merge are performed by the user. No new dependencies or environment variables are required.

The separate room age-range defect remains tracked in SKAO-43. Full attendance entry, parent onboarding, billing and document collection remain later work.
