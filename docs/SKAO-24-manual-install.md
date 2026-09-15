# SKAO-24 — install, test and integrate on Ubuntu

This feature branch starts from `development` commit `d18fb0b`, which includes merged SKAO-23. It adds staff records, room assignments and an accurate active-staff total. These instructions are for you to run in the Ubuntu VMware terminal. The repository path is assumed to be `~/workspace/ska_organizer`.

Automated test execution, PostgreSQL migration, manual testing, pushing and merging are left to you. See the package's `VERIFICATION.md` for the checks performed before delivery.

## 1. Import the committed feature branch

Download `SKAO-24-staff-directory.zip` into Ubuntu Downloads. If downloaded on Windows, copy it into Ubuntu first. Extract and verify:

```bash
unzip ~/Downloads/SKAO-24-staff-directory.zip -d ~/Downloads
cd ~/Downloads/SKAO-24
sha256sum -c SHA256SUMS
```

Stop both running application terminals with Ctrl+C. Check your repository:

```bash
cd ~/workspace/ska_organizer
git status --short
```

Save or commit any listed changes before switching branches. Import:

```bash
git fetch origin development
git bundle verify ~/Downloads/SKAO-24/SKAO-24.bundle
git fetch ~/Downloads/SKAO-24/SKAO-24.bundle feature/SKAO-24-staff-directory
git switch -c feature/SKAO-24-staff-directory FETCH_HEAD
git log -1 --oneline
git status --short
```

The package contains an already committed branch. You do not need `git add` to import it. If the branch name already exists, inspect it before reusing it; do not reset or delete it. Bundle verification needs the development history containing `d18fb0b`. A shallow checkout may need that history fetched first.

If development has advanced since `d18fb0b`, bring those changes into the feature branch before testing:

```bash
git merge origin/development
```

Resolve any reported conflicts before continuing. Dependencies are unchanged. If dependencies are missing on your checkout, run `npm ci` separately from `server` and `client`.

## 2. Back up and migrate PostgreSQL

Keep the existing `server/.env`, database, login accounts, client API address, allowed origins and facility time zone. No new environment variables are required. No seed or database reset is needed.

With the application stopped, back up the project's existing database using its configured role. For the existing `ska_app` / `ska_organizer` setup:

```bash
mkdir -p ~/ska_backups
pg_dump -h 127.0.0.1 -U ska_app -d ska_organizer -W -Fc -f ~/ska_backups/ska_organizer-before-SKAO-24-$(date +%Y%m%d-%H%M%S).dump
```

Enter the database password when prompted. Continue after the backup succeeds:

```bash
cd ~/workspace/ska_organizer/server
npm run db:migrate
```

Expected new migration: **008-staff-directory**. It adds an empty StaffMembers table and retains existing rooms, children, meals, attendance and accounts. Run this before starting the upgraded backend. The migration runner rejects startup while migrations are pending.

## 3. Run your automated checks

Backend, including the new staff API and permission coverage:

```bash
cd ~/workspace/ska_organizer/server
npm test
npm run test:postgres
```

`TEST_DATABASE_URL` must reference your separate database ending in `_test`. PostgreSQL tests create isolated schemas and remove them afterward. The staff PostgreSQL test checks migration repeatability, restart persistence, retained room references and account separation.

Frontend:

```bash
cd ~/workspace/ska_organizer/client
npm test
npm run build
npm run lint
npm run test:browser
```

Browser tests start their own servers on ports 3009 and 5179. They use an isolated mock backend. If Playwright reports a missing Chromium executable, run this from `client`, then repeat the browser tests:

```bash
npx playwright install --with-deps chromium
npm run test:browser
```

There is one existing hook-dependency lint warning in `MealsManagement.tsx`. Some existing backend tests deliberately provoke internal errors while checking transaction rollback; use the final PASS/FAIL summary to assess the test result.

For focused troubleshooting, the new suites can be selected with:

```bash
cd ~/workspace/ska_organizer/server
npm test -- --runTestsByPath tests/staff.test.js
npm run test:postgres -- --runTestsByPath tests/staff.test.js tests/staff.postgres.test.js
cd ../client
npm test -- src/pages/Staff.test.tsx
npm run test:browser -- tests/browser/staff-directory.spec.ts
```

## 4. Start normally

Ubuntu terminal 1:

```bash
cd ~/workspace/ska_organizer/client
npm run dev
```

Ubuntu terminal 2:

```bash
cd ~/workspace/ska_organizer/server
node index.js
```

Open the frontend **Network** address in Windows Chrome and sign in as an administrator.

## 5. Manual staff check

Use synthetic names while verifying behavior. Keep track of the initial active-staff total so you can compare changes.

1. Open **Accounts** and note the existing accounts. Open **Staff**. An empty directory after migration is expected; staff records are not inferred from accounts.
2. Select **Add staff**. Submit blank details and confirm the form rejects them. Enter a synthetic full name and job role, leave the room Unassigned, and save. Confirm the record appears and the active total increases by one.
3. Create or choose an active configured room under **Rooms & Classes**. Return to Staff, select **Refresh staff**, edit the synthetic person and assign that room. Update their job role and save.
4. Refresh Chrome. Confirm the name, role and room persist. Stop and restart the backend with Ctrl+C then `node index.js`; refresh Chrome again and verify the record remains.
5. Search for part of the name, select the assigned room filter, and select another room or Unassigned. Confirm filtering changes the matching records but keeps the facility-wide active total. Reset filters.
6. Select **Deactivate** and confirm. The record leaves the Active view and the active total decreases. Select **Inactive** or **All statuses**: the same person, job role and room must still be shown. Refresh Chrome and reselect Inactive to confirm it persists.
7. Edit the inactive record, check **Active staff member**, and save. Return to Active status. Confirm the person and original room return and the count increases.
8. Assign the synthetic person to a room and archive that room. Return to Staff and select **Refresh staff**. Confirm the existing assignment shows the archived label and the person's name/job role can still be edited. New staff cannot be assigned to the archived room.
9. Deactivate that person, then try to reactivate while keeping the archived room. Saving must be rejected. Select an active room or Unassigned and save successfully.
10. In two Chrome tabs, open the same staff record for editing. Save a job-role change in the first. Try saving a name change in the second. Confirm a conflict message and retained typed edits. Select **Reload staff record**, confirm, review the first tab's change, then save your intended update.
11. Open **Dashboard** and confirm **Active Staff** matches the facility-wide count on Staff. Other dashboard metrics are separate work under SKAO-28. Existing meal-plan staff counts must remain unchanged.
12. Return to **Accounts**: staff creation, job-role changes and deactivation must not have added or changed any account. Staff job role is separate from application permissions. To revoke login access, disable the account explicitly in Accounts.
13. Sign in with an editor and then a viewer account. Each can view/search/filter Staff but must not see Add, Edit or Deactivate controls. Return to your administrator account when finished.
14. If there are more than 25 matching staff, verify Next/Previous page and that the active total counts every page. Deactivating the final record on the last page should return to the preceding page.

Deactivate synthetic records you no longer need after testing. Records remain available in the Inactive view.

## 6. Push and merge after your checks pass

Review any fixes you made during testing and commit them first. Then:

```bash
cd ~/workspace/ska_organizer
git status --short
git push -u origin feature/SKAO-24-staff-directory
```

Open a GitHub pull request with base **development**, compare **feature/SKAO-24-staff-directory**, and title **SKAO-24: Add staff directory and room assignments**. Merge after your tests and review succeed, then update your local development checkout:

```bash
git switch development
git pull --ff-only origin development
```

Mark SKAO-24 and subtasks SKAO-52, SKAO-53 and SKAO-54 Done after successful testing and integration. They remain In Review at delivery.
