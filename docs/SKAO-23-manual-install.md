# SKAO-23 — install, test and integrate on Ubuntu

The committed feature branch starts from `development` commit `874bd71`, which includes merged SKAO-22. Use your Ubuntu VMware terminal and Windows Chrome. The commands assume the repository is `~/workspace/ska_organizer`.

## 1. Import the completed branch

Download `SKAO-23-daily-attendance.zip` into Ubuntu Downloads. If you downloaded it on Windows, copy it into Ubuntu first.

~~~bash
unzip ~/Downloads/SKAO-23-daily-attendance.zip -d ~/Downloads
cd ~/Downloads/SKAO-23
sha256sum -c SHA256SUMS
~~~

Stop both running application terminals with Ctrl+C. Check your checkout:

~~~bash
cd ~/workspace/ska_organizer
git status --short
~~~

Save or commit any listed changes before switching branches. Then import:

~~~bash
git fetch origin development
git bundle verify ~/Downloads/SKAO-23/SKAO-23.bundle
git fetch ~/Downloads/SKAO-23/SKAO-23.bundle feature/SKAO-23-daily-attendance
git switch -c feature/SKAO-23-daily-attendance FETCH_HEAD
git log -1 --oneline
git status --short
~~~

These changes are already committed. No `git add` is needed just to import the branch. If Git reports the branch already exists, inspect it before reusing it; do not reset or delete it. If bundle verification reports missing prerequisites, fetch the development history containing merged SKAO-22.

## 2. Back up and migrate PostgreSQL

Keep your existing database, administrator, passwords, client API address and allowed origins. Do not reset or reseed your working database. Dependencies are unchanged; if they are missing, run `npm ci` separately in `server` and `client`.

For the existing database/role used by this project:

~~~bash
mkdir -p ~/ska_backups
pg_dump -h 127.0.0.1 -U ska_app -d ska_organizer -W -Fc -f ~/ska_backups/ska_organizer-before-SKAO-23.dump
~~~

Enter the database password when prompted. Choose a different backup filename if one already exists. Continue after a successful backup.

Add this line to your existing `server/.env`:

~~~dotenv
FACILITY_TIME_ZONE=America/Los_Angeles
~~~

Then run:

~~~bash
cd ~/workspace/ska_organizer/server
npm run db:migrate
~~~

Expected new migration: `007-daily-attendance`. Existing attendance is preserved; duplicates or invalid legacy times may be marked for review. Migration is additive and transactional. Do not revert the code to an older attendance implementation while continuing to write to the upgraded database; retain the backup for a deliberate recovery if needed.

## 3. Run your checks

Backend:

~~~bash
cd ~/workspace/ska_organizer/server
npm test
npm run test:postgres
~~~

`TEST_DATABASE_URL` must reference the separate database ending in `_test`. Tests use isolated schemas that are removed afterward. Do not substitute your working database.

Frontend:

~~~bash
cd ~/workspace/ska_organizer/client
npm test
npm run build
npm run lint
npm run test:browser
~~~

Browser tests start their own servers on ports 3009 and 5179. If Chromium is missing, run this from `client`, then retry browser tests:

~~~bash
npx playwright install --with-deps chromium
npm run test:browser
~~~

Some regression tests deliberately cause audit/history writes to fail, so an internal-server-error console entry can occur in a passing suite. Judge the final PASS/FAIL result. There is an existing unrelated hook-dependency lint warning in `MealsManagement.tsx`.

Automated suites and PostgreSQL integration have been left for you to run. The package does not claim they passed.

## 4. Start normally

Ubuntu terminal 1:

~~~bash
cd ~/workspace/ska_organizer/client
npm run dev
~~~

Ubuntu terminal 2:

~~~bash
cd ~/workspace/ska_organizer/server
node index.js
~~~

Open the frontend **Network** address in Windows Chrome and sign in.

## 5. Manual attendance check

Use synthetic children and rooms for testing.

1. Create two active rooms with valid age ranges/capacities and two synthetic children assigned to different rooms.
2. Open **Attendance**. Verify the facility time zone is America/Los_Angeles and select the first room. Its child should show **Not checked in**; the other room's child should be excluded.
3. Check in the first child. Verify **Present** and an arrival timestamp. Refresh Chrome, then restart the backend and refresh again. The open visit must remain.
4. Open the same attendance room in two browser tabs. Attempt the same arrival from both views. Refresh both: there must be one open visit. A stale action may request a refresh, but must not duplicate the visit.
5. Check out. Refresh and confirm the departure remains unchanged. A later check-in creates a new visit; check it out to leave clean test attendance.
6. Open **Correct / history** for a completed visit. Change the arrival to one minute earlier, enter a reason and confirm. Reopen and verify original/new values, acting account, correction time and reason. Restart the backend and verify again.
7. Try a blank reason, a future arrival, a departure before arrival, and a change that overlaps another visit. Saving must be rejected.
8. Open the same correction in two tabs. Save in one, then try to save the older version in the other. It must report a conflict and retain the typed edits until you deliberately reload.
9. Void a mistaken visit with a reason. Confirm it stays visible as **Voided** and is excluded from attendance counts. Its original timestamps remain in history. Restore it only if it represents a real visit and does not overlap another.
10. Change a child's assigned room or end enrollment after a completed visit. The earlier visit must still show its original room. For an existing open visit, checkout must remain possible.
11. Select an earlier date with attendance, and test room/name filters. Historical views show recorded visits rather than today's unrecorded roster. A read-only account can read visits/history and cannot record or correct attendance.
12. Review any existing **Needs review** rows. Void duplicate mistakes first and correct verified times. Never invent departure times to clear a warning.

## 6. Manual meal-count check

Run this on a weekday; weekend attendance import is intentionally unavailable because menus cover Monday–Friday.

1. Start with clean test attendance, with no open visits from earlier dates. Check in two synthetic children and leave them present.
2. In **Meals → Planner**, select the week containing today. Generate or reopen a menu with complete recipes.
3. Set weekly children to 20 and staff to 5. Select **Review today's attendance count**. Confirm it reports the children currently present across all rooms and a sampling time. The planner counts must stay unchanged at this point.
4. Select **Apply count to YYYY-MM-DD only**. Only today's child count changes; weekly default, other weekdays and staff stay at their previous values. Verify shopping recalculates.
5. Manually change a different day's count. Then change weekly default children. The days with explicit counts should retain those values; other days should follow the default.
6. Save Menu, refresh and reopen. Verify the date-specific counts and shopping list persisted. Check **Print List** includes the daily counts.
7. Select a future week. Attendance import must be disabled, while its counts remain independently editable. Switch back and verify today's week remains intact.
8. Check out the test children. The saved menu should remain unchanged. A new attendance sample should show the new present count; it changes the draft only after you explicitly apply it.

## 7. Push and merge after your checks pass

If development has advanced, fetch and merge `origin/development` into this feature branch, resolve any conflicts, and repeat the affected checks before merging the PR.

~~~bash
cd ~/workspace/ska_organizer
git status --short
git push -u origin feature/SKAO-23-daily-attendance
~~~

If you fixed anything during testing, review and commit those changes first.

Open a GitHub PR with base `development`, compare `feature/SKAO-23-daily-attendance`, and title `SKAO-23: Add daily attendance and today-only meal counts`. After passing tests and review, merge the PR and update your local checkout:

~~~bash
git switch development
git pull --ff-only origin development
~~~

Mark SKAO-23 and subtasks SKAO-49, SKAO-50 and SKAO-51 Done after your testing and integration succeed. They remain In Review at handoff. Future document upload/scanning and clickable room-child lists remain separate stories.
