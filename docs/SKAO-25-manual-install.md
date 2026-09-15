# SKAO-25 — install, test and integrate on Ubuntu

This feature starts from `development` commit `ad4eafb4aec902100dea1a15caa187a868843796`, which includes merged SKAO-24. It adds persistent inventory quantities, exact storage locations, low/out-of-stock status and movement history. These instructions are for you to run in the Ubuntu VMware terminal, using `~/workspace/ska_organizer`.

The package contains a committed feature branch. Automated tests, PostgreSQL migration, manual testing, pushing and merging are left to you. See `VERIFICATION.md` in the download for checks performed before delivery.

## 1. Import the feature branch

Download `SKAO-25-inventory.zip` into Ubuntu Downloads. If downloaded in Windows, copy it into Ubuntu first. Extract and check its contents:

```bash
unzip ~/Downloads/SKAO-25-inventory.zip -d ~/Downloads
cd ~/Downloads/SKAO-25
sha256sum -c SHA256SUMS
```

Each listed file should say `OK`. This checks that the files match the supplied checksums; it does not execute them.

Stop both application terminals with Ctrl+C. Check your checkout:

```bash
cd ~/workspace/ska_organizer
git status --short
```

Save or commit any listed changes before switching branches. Then import:

```bash
git fetch origin development
git bundle verify ~/Downloads/SKAO-25/SKAO-25.bundle
git fetch ~/Downloads/SKAO-25/SKAO-25.bundle feature/SKAO-25-inventory
git switch -c feature/SKAO-25-inventory FETCH_HEAD
git log -1 --oneline
git status --short
```

No `git add` is needed to import the committed code. If the branch already exists, inspect it before reusing it; do not reset or delete it. Bundle verification requires the development history containing `ad4eafb`. A shallow checkout may need that history fetched first. If development has advanced, bring it into the feature branch before testing:

```bash
git merge origin/development
```

Resolve any merge conflicts before continuing. Dependencies are unchanged. If dependencies are missing, run `npm ci` separately in `server` and `client`.

## 2. Back up and migrate PostgreSQL

Keep your existing `server/.env`, PostgreSQL configuration, login accounts, client API address, allowed origins and facility time zone. No new environment variables or seed command are needed.

With the application stopped, back up its existing database. For your `ska_app` / `ska_organizer` setup:

```bash
mkdir -p ~/ska_backups
pg_dump -h 127.0.0.1 -U ska_app -d ska_organizer -W -Fc -f ~/ska_backups/ska_organizer-before-SKAO-25-$(date +%Y%m%d-%H%M%S).dump
```

Enter the database password when prompted. After the backup succeeds:

```bash
cd ~/workspace/ska_organizer/server
npm run db:migrate
```

Expected new migration: **009-inventory-ledger**. It adds empty inventory and movement tables while retaining existing application data. Run it before starting the upgraded server. An empty Inventory page is expected; the former read-only demonstration items are replaced by records you enter.

## 3. Run your automated checks

Backend:

```bash
cd ~/workspace/ska_organizer/server
npm test
npm run test:postgres
```

`TEST_DATABASE_URL` must name your separate database ending in `_test`. The PostgreSQL suites create isolated schemas and remove them afterward. The inventory PostgreSQL case checks migration repeatability, exact fractional stock, ingredient references, history and retry behavior after database reconnection.

Frontend:

```bash
cd ~/workspace/ska_organizer/client
npm test
npm run build
npm run lint
npm run test:browser
```

Browser tests use their own isolated mock backend on port 3009 and frontend on port 5179. If Playwright reports a missing Chromium executable, run this from `client`, then repeat the browser command:

```bash
npx playwright install --with-deps chromium
npm run test:browser
```

There is one existing hook-dependency lint warning in `MealsManagement.tsx`. Some backend tests intentionally trigger internal errors to check rollback; assess the final PASS/FAIL summary.

For focused troubleshooting of this feature:

```bash
cd ~/workspace/ska_organizer/server
npm test -- --runTestsByPath tests/inventory.test.js
npm run test:postgres -- --runTestsByPath tests/inventory.test.js tests/inventory.postgres.test.js
cd ../client
npm test -- src/pages/Inventory.test.tsx
npm run test:browser -- tests/browser/inventory.spec.ts
```

## 4. Start the application normally

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

Open the frontend **Network** address in Windows Chrome. Sign in as an administrator.

## 5. Manual inventory checks

Use a synthetic item and keep its name distinct so it is easy to find.

1. Open **Inventory**, select **Add inventory item**, and try saving with blank details. Confirm the missing name, category, location and reason are rejected.
2. Create `Synthetic paper` with category `Art supplies`, exact location `Studio / Cupboard / Shelf 2`, unit `pack`, opening count `10`, reorder threshold `2`, and reason `Opening physical count`. Leave the ingredient link empty. Confirm it appears as Available and history contains the opening count with your username and time.
3. Select **Adjust stock**, then perform the following changes. Check the quantity, status and history after each save:

   | Change type | Quantity entered | Expected stock | Expected status |
   |---|---:|---:|---|
   | Stock addition | 5 | 15 packs | Available |
   | Usage | 13 | 2 packs | Low stock |
   | Usage | 3 | Rejected; remains 2 packs | Low stock |
   | Count correction | 0 | 0 packs | Out of stock |

   Enter a reason each time. The failed usage must not create a history entry. A count correction of zero sets the total to zero and preserves earlier entries.

4. Edit the item and change its location to `Studio / Cupboard / Shelf 3` and threshold to `3`. Supply a reason. Confirm history shows the previous and new location, and the quantity stays zero.
5. Refresh Chrome. Stop and restart the backend, then refresh Chrome again. Confirm the item, location, quantity, threshold and history remain. If they disappear, confirm your existing backend configuration uses `DB_ADAPTER=sequelize` and startup reports PostgreSQL initialized.
6. Search for the synthetic item. Combine category, location and status filters, then reset them. Summary cards must continue counting all inventory. If more than 25 records exist, check Next/Previous page.
7. Create or choose a synthetic `lb` ingredient in **Meals → Meal Setup**. Return to Inventory and select **Refresh inventory**. Create linked food stock using that ingredient, with opening count `0.1`, threshold `0.3` and a reason. The unit should be `lb`. Add `0.2`; the new stock must be exactly `0.3 lb` and Low stock.
8. Try negative numbers, more than six decimal places, blank reasons and usage greater than stock. These must be rejected without changing stock or history. A food link uses an ingredient ID and does not automatically subtract quantities from meal plans.
9. Edit an item with stock above zero. Unit and ingredient link should be disabled. Count it down to zero with a reason; the unit/link can then be changed. Earlier movement entries must keep their old units. Archived ingredients cannot be selected for new links, while an existing archived link remains usable.
10. In two Chrome tabs, open **Adjust stock** for the same item. Save an addition in the first tab. Try saving from the second tab: it must show a conflict and keep your entries. Select **Reload inventory item**, confirm replacement of the draft, review the latest balance and enter the intended adjustment again.
11. Open an edit form, enter a new name and change list filters. Your unsaved name must stay in the form. Cancel when finished.
12. Stop the backend and select **Refresh inventory**. Confirm an error replaces loading. Restart `node index.js` and select Refresh again. Records must return. A failed History read should also offer a retry.
13. Sign in as an editor and verify inventory editing and stock adjustments are available. Sign in as a viewer and verify records/history can be read but Add, Edit and Adjust controls are absent. Return to your administrator account afterward.
14. Check a previously saved meal plan. Its saved headcounts, recipe quantities and in-house entries should remain unchanged. Purchase receipts and stock-to-shopping integration will follow in SKAO-26. The Dashboard inventory card is separate work under SKAO-28; use Inventory for current stock figures.

Synthetic items are retained in history. Record a final zero count with a reason for test items you no longer need; there is no deletion action in this release.

## 6. Push and merge after your checks pass

Review and commit any fixes you make during testing. Then:

```bash
cd ~/workspace/ska_organizer
git status --short
git push -u origin feature/SKAO-25-inventory
```

Create a GitHub pull request with base **development**, compare **feature/SKAO-25-inventory**, and title **SKAO-25: Track inventory quantities and storage locations**. Merge after testing and review succeed, then update your development checkout:

```bash
git switch development
git pull --ff-only origin development
```

Mark SKAO-25 and subtasks SKAO-56, SKAO-57 and SKAO-58 Done after successful testing and integration. They remain In Review at delivery.
