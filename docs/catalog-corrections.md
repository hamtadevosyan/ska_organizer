# Correcting meals and recipes (SKAO-19)

Meal Setup now supports edits, archiving/restoring, recipe quantity changes, and
confirmed removal of recipe links. Saved weekly plans retain their historical
meal names, recipes, units, counts and stock.

## Upgrade the existing Ubuntu installation

After importing the SKAO-19 commit into `~/workspace/ska_organizer`, stop the
frontend and backend with Ctrl+C. Keep the existing databases and configuration.
For an operational database, take your normal backup before applying the upgrade.

```bash
cd ~/workspace/ska_organizer/server
npm ci
npm run db:migrate
npm test
npm run test:postgres
```

Migration `003-catalog-corrections` adds `archived` flags and enforces one recipe
link for each meal/ingredient pair. If duplicate links already exist, it retains
the oldest link ID and sums their quantities, then removes the redundant links.
This preserves the total that the previous shopping calculation used. The upgrade
is transactional; an error (including a sum exceeding the stored numeric range)
rolls back the migration. It does not modify saved weekly snapshots or stock.
Run it once with the backend stopped; repeating `db:migrate` skips completed
migrations. No database recreation or reseeding is required.

```bash
cd ~/workspace/ska_organizer/client
npm ci
npm run build
npm run lint
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

Resume your usual startup: `npm run dev` in the client terminal and
`node index.js` in the server terminal. Open Vite's **Network** URL in Windows Chrome.

## Correct the catalog

1. Open **Meals → Meal Setup**.
2. Select a meal with **Choose meal**. Edit its name, description or meal type and
   click **Save meal**. Selecting **New meal** creates another catalog entry.
3. Select an ingredient with **Choose ingredient**, correct its name and click
   **Save ingredient**. A unit can change only before that ingredient has recipe,
   saved-week or shelf quantities. If blocked, create a separate ingredient with
   the correct unit and update the affected recipes; do not reinterpret old stock.
4. Under **Recipe for …**, edit a quantity per person and click **Save quantity**.
   **Remove** asks for confirmation before removing that link. The ingredient
   remains in the catalog and other recipes remain intact.
5. **Add ingredient to recipe** only offers active ingredients not already linked
   to this meal. Edit the existing row to change its quantity. The API and database
   also reject duplicates, including simultaneous requests.
6. **Archive meal** or **Archive ingredient** asks for confirmation. Archived
   entries disappear from new planner choices and new recipe assignments. Enable
   **Show archived meals and ingredients** to find and restore them. Restore a meal
   before changing its recipe. An archived ingredient can be removed from a recipe;
   it must be restored before being assigned again.

Names must be non-empty after trimming, with at most 255 characters. Supported
meal types are Breakfast, Morning snack, Lunch and Afternoon snack. Quantities
must be positive, below one trillion, with at most six decimal places. API errors
appear beside the affected fields; rejected entries remain available for correction.

## Return to Planner

Returning from Meal Setup reloads the meal catalog and recalculates the active
draft. Counts, stock and meal selections remain in the draft. Newly generated
menus use current recipes. Edited meals appear in their current meal-type choices.
Changing a meal's type may require choosing another meal for its old time slot.

A missing recipe, invalid recipe quantity, or archived ingredient in a current
recipe produces a warning naming the meal and day. **Edit recipe for …** opens
that meal in Meal Setup. **Save Menu** and **Print List** stay disabled until the
recipes are complete and calculation succeeds. The final printable table is also
withheld, so a partial list is not presented as ready.

A previously saved week keeps its original recipes when reopened, including meals
or ingredients archived later. To adopt catalog corrections for that week, click
**Use current recipes**, review the new quantities and any warnings, then save.
Until Save succeeds, the stored week is unchanged. **Reopen saved week** discards
that week's unsaved edits after confirmation and restores its historical version.

If an older saved week contains an empty recipe, complete the recipe in Meal Setup
and choose **Use current recipes** to repair its draft before saving again.

## API changes

Success responses use `{ "data": ... }`. Validation errors use
`{ "error": { "message": "...", "fields": { "name": "..." } } }`.
Field names include `name`, `type`, `description`, `unit`, `ingredientId`, and
`quantity`. Invalid input returns 400, missing records 404, and duplicate links,
unsafe unit changes or edits to an archived meal's recipe return 409.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/meals?type=breakfast` | Active meals; optional type filter |
| `GET /api/meals?includeArchived=true` | All meals, including archived entries |
| `PUT /api/meals/:id` | Partial update: name, description, type, archived |
| `DELETE /api/meals/:id` | Archives the meal; never hard-deletes it |
| `GET /api/ingredients?includeArchived=true` | All ingredients; default list excludes archived entries |
| `PUT /api/ingredients/:id` | Partial update: name, unit, shelfLifeDays, archived |
| `DELETE /api/ingredients/:id` | Archives the ingredient; retains references |
| `POST /api/meals/:mealId/ingredients` | Adds a unique ingredient link with a positive numeric quantity |
| `PUT /api/meals/ingredients/:id` | Updates the existing quantity |
| `DELETE /api/meals/ingredients/:id` | Removes only the recipe link |

Catalog changes and preview reads are serialized in PostgreSQL transactions so
validation and recipe capture cannot race with another catalog edit. The database
unique constraint also protects callers outside the API.

Dated preview accepts optional `refreshRecipes: true` to capture current recipes
instead of a saved week's historical recipe snapshots. Its response includes
`warnings: [{ day, slot, mealId, mealName, message }]`. An incomplete preview has
**no `previewToken`** and cannot be submitted to the save endpoint. Complete
previews keep the signed, expiring snapshot contract introduced in SKAO-18.

The older undated APIs remain compatible. Use the dated planner endpoints for
new integrations and recipe-completeness checks.

## Acceptance checks

- Correct a meal's name/type/description and an ingredient name without changing
  their IDs. Confirm the matching planner dropdown refreshes after returning.
- Attempt duplicate assignments and invalid quantities; confirm inline errors,
  preserved input, and only one stored link per ingredient.
- Plan one egg per person for three days, with 4 children and 1 staff, and 2 eggs
  in house: 15 needed, 13 buy. Save. Edit the recipe to two eggs per person.
  Reopen the saved week: still 15/13. Choose **Use current recipes**: 30/28.
- Cancel a recipe removal, then confirm it. Removing the last link must show a
  named warning and disable Save/Print until the recipe is repaired.
- Archive a referenced meal and ingredient. Reopen the saved week and confirm
  its original totals remain intact. Restore the catalog entries and use them again.
- Try changing the unit of a referenced ingredient; verify rejection and no
  change to its stored unit or quantities.

Automated coverage includes API cases on mock/PostgreSQL adapters, a migration
from duplicate links, rendered React controls, and a Chromium flow using an
isolated mock server. Native PostgreSQL and Chromium tests must pass in Ubuntu or
GitHub CI before merging. No test should connect to the application database.

### Implementation verification — September 8, 2026

- Mock API suite: 50 tests passed.
- React interaction suite: 22 tests passed.
- Production TypeScript/Vite build: passed.
- ESLint: no errors; the existing `MealsManagement.tsx` hook dependency warning remains.
- Embedded PostgreSQL: 54 tests passed, including the new catalog and migration
  cases and separate-process persistence. One existing foreign-key rollback test
  was excluded because of a previously reproduced PGlite socket limitation; the
  test remains enabled and unchanged in the native suite.
- Two Chromium flows are configured and discoverable. Full browser execution,
  all 55 native PostgreSQL tests and the database restart check remain Ubuntu/CI
  delivery gates. Embedded PostgreSQL results do not replace those gates.

### Native Ubuntu verification — September 7, 2026

- Node 22.17.1 and native PostgreSQL 14: all 50 mock tests and all 55 PostgreSQL
  tests passed, with no exclusions. Tests used the existing separate test database.
- Production build, all 22 React tests, and both full Chromium flows passed.
  ESLint passed with the existing `MealsManagement.tsx` warning.
- With the backend stopped, a custom-format application database backup was
  taken before migration `003-catalog-corrections` applied successfully.
  Existing databases and `.env` files were preserved; no reseeding was performed.
- Browser verification covered incomplete-recipe repair, explicit adoption of
  corrected quantities, cancellation/confirmation of removal, archiving with
  saved history retained, and the existing independent-week save/reload flow.
- PostgreSQL 16 restart verification and final-commit CI results are checked in
  GitHub Actions before merge.
