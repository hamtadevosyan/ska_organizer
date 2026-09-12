# SKAO-22 — manual Ubuntu installation, testing and integration

Use your Ubuntu VMware terminal and Windows Chrome. The repository path below is `~/workspace/ska_organizer`; adjust it if your checkout is elsewhere. This branch starts from merged SKAO-21 development commit `d95d071`.

## 1. Download and import

Download `SKAO-22-child-roster.zip` into Ubuntu Downloads. Copy it from Windows to Ubuntu first if needed, then extract:

~~~bash
unzip ~/Downloads/SKAO-22-child-roster.zip -d ~/Downloads
~~~

Stop both running application terminals with Ctrl+C. Check your current checkout:

~~~bash
cd ~/workspace/ska_organizer
git status --short
~~~

If Git lists changes, save or commit them before switching branches. Do not discard them.

Import the already committed branch:

~~~bash
git fetch origin development
git bundle verify ~/Downloads/SKAO-22/SKAO-22.bundle
git fetch ~/Downloads/SKAO-22/SKAO-22.bundle feature/SKAO-22-child-roster
git switch -c feature/SKAO-22-child-roster FETCH_HEAD
git log -1 --oneline
git status --short
~~~

The branch contains the completed implementation. No `git add` is needed just to import it. Your development branch stays in place. If bundle verification reports a missing prerequisite, make sure the repository has fetched the merged SKAO-21 development history.

## 2. Back up and migrate PostgreSQL

Keep your existing server and client environment settings. Do not recreate the administrator or reseed/reset your working database.

For the database and role already used in this project:

~~~bash
mkdir -p ~/ska_backups
pg_dump -h 127.0.0.1 -U ska_app -d ska_organizer -W -Fc -f ~/ska_backups/ska_organizer-before-SKAO-22.dump
~~~

Enter the database password when prompted. Use a different filename if that backup already exists. Continue only after the backup succeeds.

~~~bash
cd ~/workspace/ska_organizer/server
npm run db:migrate
~~~

Expected new migration: `006-child-enrollment`. It adds enrollment status and reference protection. Existing children become active by default; review their status after upgrading. Missing legacy birth dates are left unknown. Your current `0–0 months` room is preserved; its separate validation issue is SKAO-43.

Dependencies are unchanged from SKAO-21. If dependencies are missing, run `npm ci` separately in `server` and `client`.

## 3. Run the automated tests

Backend:

~~~bash
cd ~/workspace/ska_organizer/server
npm test
npm run test:postgres
~~~

Keep `TEST_DATABASE_URL` pointed to the separate database ending in `_test`. PostgreSQL tests use isolated schemas and remove them afterward. Never point tests at your working database.

Frontend:

~~~bash
cd ~/workspace/ska_organizer/client
npm test
npm run build
npm run lint
npm run test:browser
~~~

The browser tests start isolated servers on ports 3009 and 5179. If Playwright reports a missing browser, run this in the client directory, then repeat the browser tests:

~~~bash
npx playwright install --with-deps chromium
npm run test:browser
~~~

Judge the final PASS/FAIL summaries. The intentional room audit-rollback test may log an internal-server-error message while passing. There is also one existing MealsManagement.tsx lint warning. New failures should be resolved before merging.

The package includes new test coverage. Final automated and manual test results have not been claimed; these checks are yours to run.

## 4. Start the application normally

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

Open the frontend's **Network** address in Windows Chrome and sign in.

## 5. Check the child roster

Use synthetic records while testing.

1. In Rooms & Classes, create an active test room with a valid age range and capacity 1.
2. Open **Children** and select **Add child**. Create Test Child with birth date 2022-05-10, preferred name Sunny, an operational note and the test room.
3. Confirm the new row appears and the room count becomes 1. Open **View profile** and check the saved fields.
4. Edit the preferred name or note and save. Refresh and reopen the profile to confirm persistence.
5. Try saving with a blank required name or a future date of birth; saving must be rejected.
6. Create another Test Child with a different birth date and leave the room Unassigned. Review the duplicate prompt, acknowledge it, then save. Both children should exist separately.
7. Search by the preferred name and full name. Try room, Unassigned, Active, Inactive and All enrollment filters.
8. End enrollment for the first test child. Confirm the row leaves Active, remains in Inactive, and its room count becomes 0. Its profile and any earlier attendance remain.
9. Assign the second child to the capacity-1 room. Edit the inactive first child and select Active enrollment. Reactivation must require capacity acknowledgement, or let you select another room/Unassigned.
10. To check the archived-room case, end enrollment again and archive the former room. Reactivation into that archived room must be rejected; choose an active room or Unassigned.
11. Sign in with a read-only account. The roster and profiles should be visible, with no add/edit/end-enrollment controls. Administrators and editors can change profiles.
12. Restart the backend and refresh Chrome. Confirm both records, notes and enrollment states remain.

Historical attendance can be checked through View profile when a record already has attendance. The automated tests cover creating attendance, ending/reactivating enrollment, preserved IDs, and checkout after enrollment ends. The full attendance-entry UI is the next story.

Legacy records with missing birth dates show **Not recorded**. Ending enrollment does not require inventing a date; when editing the full profile, supply the correct missing required fields.

## 6. Push and integrate when your checks pass

If development has advanced while you tested, fetch it, merge `origin/development` into this feature branch, resolve any conflicts, and repeat affected checks before the PR.

~~~bash
cd ~/workspace/ska_organizer
git status --short
git push -u origin feature/SKAO-22-child-roster
~~~

If you changed code while testing, review and commit those changes before pushing.

Open a GitHub pull request:

- Base: `development`
- Compare: `feature/SKAO-22-child-roster`
- Suggested title: `SKAO-22: Add child roster and enrollment management`

After successful checks and review, merge the PR. Then update your local checkout:

~~~bash
git switch development
git pull --ff-only origin development
~~~

Mark SKAO-22 and subtasks SKAO-44, SKAO-45 and SKAO-46 Done after testing and integration succeed. SKAO-43 remains a separate open issue.
