# SKAO-21 — manual installation, testing and integration

These instructions are for your Ubuntu VMware machine. Use your own terminal and Windows Chrome.

The repository location below is `~/workspace/ska_organizer`. Adjust it only if your checkout lives somewhere else.

## 1. Download and extract

Download `SKAO-21-rooms-and-classes.zip` into Ubuntu's Downloads directory. If you download it on Windows, copy it into Ubuntu first.

Extract it with Ubuntu's archive manager, or:

~~~bash
unzip ~/Downloads/SKAO-21-rooms-and-classes.zip -d ~/Downloads
~~~

You should have `~/Downloads/SKAO-21/SKAO-21.bundle` and `START-HERE.md`.

## 2. Stop the running application and check your Git working tree

Press Ctrl+C in both the frontend and backend terminals.

~~~bash
cd ~/workspace/ska_organizer
git status --short
~~~

If Git lists your existing changes, save or commit them before switching branches. Do not discard them.

## 3. Import the implementation branch

The bundle contains a committed feature branch based on the merged SKAO-20 development commit `f09d4e4`.

~~~bash
cd ~/workspace/ska_organizer
git fetch origin development
git bundle verify ~/Downloads/SKAO-21/SKAO-21.bundle
git fetch ~/Downloads/SKAO-21/SKAO-21.bundle feature/SKAO-21-rooms-and-classes
git switch -c feature/SKAO-21-rooms-and-classes FETCH_HEAD
git log -1 --oneline
git status --short
~~~

This imports the branch without changing your development branch. The implementation is already committed; you do not need to run `git add` for the imported files.

If `git bundle verify` reports a missing prerequisite, run the fetch from origin and verify again. Do not import into an unrelated repository.

## 4. Update the database

Keep your existing `server/.env`, database password, accounts and meals. This feature does not require new environment settings or a new administrator.

Before changing a database you want to keep, take a backup. For the database/user already used in this project:

~~~bash
mkdir -p ~/ska_backups
pg_dump -h 127.0.0.1 -U ska_app -d ska_organizer -W -Fc -f ~/ska_backups/ska_organizer-before-SKAO-21.dump
~~~

The command prompts for the database password. Use a different filename if that backup already exists.

Run the additive migration:

~~~bash
cd ~/workspace/ska_organizer/server
npm run db:migrate
~~~

If dependencies are missing, run `npm ci` in `server` and `client`. Dependencies are unchanged from SKAO-20, so reinstalling is normally unnecessary.

## 5. Run the automated checks

Backend mock and PostgreSQL tests:

~~~bash
cd ~/workspace/ska_organizer/server
npm test
npm run test:postgres
~~~

`TEST_DATABASE_URL` must keep pointing to the separate database ending in `_test`, as configured for SKAO-17/SKAO-20. PostgreSQL tests create and remove isolated test schemas. Never point them at your working database.

Frontend checks:

~~~bash
cd ~/workspace/ska_organizer/client
npm test
npm run build
npm run lint
npm run test:browser
~~~

The browser suite starts its own isolated mock backend/frontend on ports 3009 and 5179. It does not use your working PostgreSQL database. If Playwright reports that Chromium is missing, install its browser in Ubuntu:

~~~bash
npx playwright install --with-deps chromium
npm run test:browser
~~~

Do not merge while a check fails. A pre-existing ESLint warning in MealsManagement.tsx may still appear; it is not a new SKAO-21 error.

## 6. Start the app using your usual workflow

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

Open the frontend's Network address in Chrome on Windows and sign in with your administrator account.

## 7. Check Rooms & Classes manually

1. Open **Rooms & Classes**.
2. Click **Add room**. Enter a room name, minimum/maximum age in months, capacity and active status. For a synthetic test, use Test Room, 24–60 months and capacity 1.
3. Save, edit the name or capacity, then refresh the browser. Confirm the saved settings remain.
4. Try a blank name, maximum age below minimum age, zero capacity and fractional capacity. Each should be rejected.
5. Open **Activity Planner** and confirm the saved room appears in its Room selector. The existing schedule page at `/schedule` also has a database room selector.
6. Archive the test room. Enable **Show archived rooms** and confirm it remains visible with the same settings and assigned count.
7. Edit the archived room and check Active to reactivate it.
8. Sign in as a read-only account. Room counts should be visible and management/assignment controls unavailable. An editor may assign existing children but cannot change room settings.
9. Restart the backend, refresh and sign in again if prompted. Confirm the rooms remain.

If the migration preserved old room references, they appear under **Show archived rooms** as imported rooms. Configure their real ages and capacity before activating them.

## 8. Check assignment warnings

The complete Children management page is a later story. The Rooms page can assign existing records from the children API, and the supplied API tests create synthetic children in isolated test storage to cover this behavior.

If your working database already contains child records:

1. Choose a child and an active room under **Assign an existing child**.
2. Confirm the proposed count, save, and check the room count.
3. With the room at capacity, choose another child. The page should show a warning and disable Assign child until you acknowledge it.
4. Move a child to another room or remove the assignment. Check both room counts.
5. Archive an assigned room. Existing children keep their room reference. New assignments to it must be rejected.

Use synthetic records while evaluating the feature. Existing records are not automatically deleted after a manual test.

## 9. Push and merge after your tests pass

~~~bash
cd ~/workspace/ska_organizer
git status --short
~~~

If you changed code while testing, review and commit those changes first. Then push the feature branch:

~~~bash
git push -u origin feature/SKAO-21-rooms-and-classes
~~~

In GitHub, open a pull request with:

- Base: `development`
- Compare: `feature/SKAO-21-rooms-and-classes`
- Suggested title: `SKAO-21: Add rooms and class management`

After review and successful checks, merge the pull request.

Update your local development checkout:

~~~bash
git switch development
git pull --ff-only origin development
~~~

Start the backend/frontend as usual. The database migration was already applied; running `npm run db:migrate` again is safe and should report no new migration.

Finally, mark SKAO-21 and subtasks SKAO-40, SKAO-41 and SKAO-42 Done after your tests and integration succeed.
