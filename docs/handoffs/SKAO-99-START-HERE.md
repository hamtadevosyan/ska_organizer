# SKAO-99 — copy saved plans and move activities

SKAO-103 is Done at the owner's request. Recipe picture/camera accuracy and mobile usability remain unfinished and are tracked in SKAO-104, a High-priority backlog story. This delivery implements SKAO-99.

## What changes

- **Copy day** and **Copy week** load a saved source room/week, show its saved activities, and preview the destination before applying.
- Adding to existing activities is the default. Replacement affects only dates with selected source activities and requires confirmation when it removes destination activities. Empty/excluded source days leave the destination alone.
- Each copy gets a new ID. Saved names, instructions, materials, times, midnight endings and legacy untimed entries are preserved. All seven weekdays and repeated activities are supported.
- Activities unsuitable for the destination room/ages or unavailable in the current library must be excluded or explicitly replaced with a suitable current activity. A newer library version never silently replaces the saved snapshot.
- **Move** changes one entry's day within its current week and keeps its ID, snapshot and times. Destination activities stay in place.
- Copy/move changes are drafts until **Save week**. **Undo copy**, **Undo move** and **Undo removal** work before saving. Failed saves retain the draft and its retry identifier; saves remain atomic.
- The preview checks the whole destination week against current inventory. Copying, moving, saving and printing consume or reserve no stock.

No migration, dependency, Windows setting, router, DNS or hardware-specific change is included.

## Apply on the Ubuntu development machine

This delivery was built from `origin/development` commit `2a1da7a` (the merged SKAO-103 work). Keep unrelated local edits safe and inspect `git status` first. Do not apply it to the Pi as a development checkout.

```bash
cd ~/workspace/ska_organizer
git status --short
git fetch origin
git switch development
git pull --ff-only origin development
git switch -c feature/SKAO-99-reuse-plans
bash ~/Downloads/SKAO-99-reuse-plans/apply-change.sh
git diff --check
git diff --stat
```

Adjust the extracted Downloads path if necessary. The script checks the entire patch before applying and stops on a mismatch; it does not reset your checkout, overwrite a conflicting file, stage, commit or push. If it reports a mismatch, retain the output and review the checkout rather than forcing the patch.

## Automated checks

Run the server and client suites in sequence. Browser fixtures use disposable synthetic data on ports 3009 and 5179, independently of the pilot database. Stop any existing fixture servers on those ports first.

```bash
cd server
npm ci
npm test
# Use the existing separate *_test PostgreSQL database from server/.env:
npm run test:postgres
cd ../client
npm ci
npm run build
npm run lint
npm test
npm run test:pwa
npx playwright install chromium
npm run test:browser
npm run test:browser:pwa
cd ..
```

The existing photo tests require the local Tesseract reader; see the previous native setup documentation if it is absent. Never point TEST_DATABASE_URL at your pilot database. The new native PostgreSQL test covers copy persistence, reconnecting and an identical retry after its source changes.

## Manual review with fictional records

1. Save a source week with activities on Monday and Sunday, repeated activities, materials, a midnight ending and (if you have one) a legacy untimed activity. Change one library description afterward.
2. Open another destination week with an existing activity. Choose **Copy week** and load the saved source. Verify dates, source, destination and activity count. The newer-version message should appear; saved instructions/materials should remain unless you deliberately select a replacement.
3. Preview and add the copy. Existing destination activities should remain. **Undo copy** should remove just that operation. Copy again and reload before Save week: accepting the discard prompt should discard the draft and its undo history. Repeat, save, reload and verify new IDs and the original saved details. The source should be unchanged.
4. Use **Copy day** into a populated destination. Choose **Replace activities on copied days** and preview. Apply must remain disabled until its replacement checkbox is checked. Cancel should leave the draft intact; applying then undoing should restore the destination.
5. Try a source activity unsuitable for a younger destination room. It must be flagged, and copying must require excluding it or choosing a suitable replacement. Archived source rooms are readable; archived destinations and viewer accounts cannot edit.
6. Move an activity to another day, review its destination/materials, and use **Move in draft**. Undo should restore its day. Repeat, save and reload: the ID and saved activity details should stay the same.
7. Check phone widths 320/390 and a desktop. Inputs and actions should fit, background controls should be inert while a copy/move dialog is open, and focus should return on cancellation.
8. Check inventory before and after copying, saving and printing. Its quantities must not change. An interrupted/conflicting save should keep the work visible. After a lost response, retry the same save to verify that it does not duplicate entries. If the source changed, undo the affected copy, reload its source and copy again. For a destination-week conflict, review your draft before accepting Reload week's discard prompt; repeatedly retrying an outdated version cannot resolve that conflict.

## Commit and merge after your review

```bash
git status --short
git add client/src/api/activities.ts client/src/components/activities client/src/pages/Activities.tsx client/src/pages/activities.css client/tests/browser/activity-reuse.spec.ts server/services/activityPlanService.js server/tests/activityPlannerReuse.test.js server/tests/activityPlannerReuse.postgres.test.js docs/handoffs/SKAO-99-START-HERE.md
git diff --cached --check
git diff --cached --stat
git commit -m "SKAO-99: reuse saved activity plans and move entries"
git push -u origin feature/SKAO-99-reuse-plans
```

Open a PR into `development` and require the existing CI workflows, including native PostgreSQL and browser checks, to pass. Review the staged files before committing so unrelated work is excluded.

After merging, use the Pi's existing deployment checkout and normal backup/update procedure:

```bash
cd ~/workspace/ska_organizer
git switch development
git pull --ff-only origin development
./SKAO.sh update
```

Perform the final check from the existing HTTPS app on an iPhone/iPad. Development, commit and push stay on Ubuntu; the Pi only pulls and runs the app.

## Verification

Passed in this workspace:

- 410 API tests across 34 suites.
- 290 client unit/component tests (282 in the full existing/helper/hook run plus 8 new copy/move component tests).
- Production build and TypeScript checks.
- ESLint: no errors; the existing `MealsManagement.tsx` effect-dependency warning remains.
- 10 service-worker/installation policy checks.
- All 6 new copy/move browser scenarios pass, including 320/390/1280 px layouts, saved snapshots, midnight/legacy times, replacement/cancel/undo, retry safety and archived-room protection.
- The full browser run passed 54 of 56 cases. Two existing cases hit timing limits: child-roster browser-context startup, and an unreadable-photo request starting after its 5-second assertion limit. Both passed on unchanged isolated reruns. No existing test or timeout was altered.
- All 5 production PWA browser checks pass.
- Patch application on a clean development base, an unchanged rerun, and safe failure on a conflicting checkout.

Browser checks used Chromium 153 through a temporary local runtime adapter; the repository's browser configurations are unchanged. The build retains its existing large-chunk advisory. Native PostgreSQL and real Pi/iPhone/iPad checks remain pending in the owner's environment. SKAO-99 stays In Progress until owner review and integration.
