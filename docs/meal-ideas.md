# Create a meal from an idea

Open **Meals → Meal Setup → Browse meal ideas**. Search starter ideas by meal
name or an ingredient, search saved meals by name, and narrow the list by meal type. The starter library contains
20 local recipe ideas; it works without an external recipe or AI service.

**Import recipe photo** adds two more choices: **Take recipe photo** opens the
device camera when supported, and **Upload recipe image** selects a file.
Use a clear, upright photo of printed English recipe text. The browser resizes
it and removes image metadata before sending it to the facility server's local
Tesseract reader. No external OCR/AI service is called. Photos and recognized
text stay in memory, are never written to the catalog or server files, and are
discarded when the import is cancelled or the page closes.

Check the recognized name and ingredient lines against **View recipe photo**.
Enter or correct the number of servings made by the entire recipe, keep one
ingredient per line, and confirm that you checked them. **Use recipe in meal
draft** divides supported amounts by the confirmed serving count and opens the
normal editable meal draft. This does not save anything. Original ingredient
lines remain visible beside the draft rows. Unrecognized measures (such as cups,
spoonfuls, packages or ranges) require you to choose a unit and enter the amount
per person; they are not silently converted. Check OCR results, fractions and
amounts before **Save meal & recipe**. Handwriting and complex layouts may need
more corrections. Recipes without readable text cannot be inferred from a food
photograph. JPEG, PNG and WebP are the most portable formats; export HEIC as JPEG
if the browser cannot open it. Each original upload is limited to 20 MB.

For an existing Ubuntu/Debian development machine or Pi, install the reader once:

```sh
bash scripts/setup-recipe-ocr.sh
```

This installs `tesseract-ocr` and English language data through APT, using sudo
when needed. Fresh `SKAO.sh setup` and the pilot server image include those
packages. Existing native deployments use the script once before their normal
`SKAO.sh update --local`. No OCR daemon, account, API key or separate service is
needed; no Windows, router or phone settings change. Other server operating
systems need a local Tesseract executable and English data on PATH.

The read-only `POST /api/meals/recipe-photo` endpoint accepts one bounded PNG
encoded in JSON, behind the existing session, CSRF, origin and write-role checks.
It allows one read at a time per server process, limits text and image size,
checks dimensions/format, and kills the local reader on cancellation or after
30 seconds. Responses are `no-store`. It creates no meal, ingredient or audit
content. Ordinary API request size limits stay at 100 KB. Missing OCR, unreadable
images and timeouts are recoverable; the user can try another image or use the
existing manual tools. Neither photos nor import drafts are cached offline.

Choose an idea to open **Make this meal your own**. Change the meal name, type or
description. Adjust ingredient amounts **per person**, replace an ingredient,
remove a row or add another. Starting amounts are editable shopping estimates.
Choose an existing ingredient when it represents what you use; its recorded
unit is kept, so shopping can use that ingredient's existing stock.

**Save meal & recipe** saves the complete new meal and all its ingredient links
together. It does not put the meal on a weekly menu. Return to **Planner** and
choose the new meal whenever you need it. Existing manual creation and recipe
correction tools remain available below the ideas picker.

Use **Saved meals** to start from a copy of your own recipe. Change its name and
ingredients before saving. The source meal and menus previously saved with
that recipe retain their original records and quantities.

An idea stays a local draft until Save. **Cancel → Discard meal** writes nothing.
Meal view switches are unavailable while a draft is open; save or discard it
first. If you follow another app link, choose **Keep editing** to return to the
draft or **Discard and leave**. Drafts are held in memory and are not an offline
storage feature.

If a save fails, the draft remains available. Correct the highlighted field or
retry the save. Retry requests reuse the same request ID to avoid duplicate
catalog records. If that ID was already saved with different details, review
the saved meal before creating another copy.

Ingredient names can be shared by more than one catalog entry. When a name is
ambiguous, choose the specific existing ingredient. Archived ingredients must
be restored through the normal catalog tools or replaced in this draft.
Different units are not automatically converted; choose the existing unit and
enter its quantity, or use an appropriate different ingredient name.

Creating a recipe does not create stock, reserve quantities or consume any
inventory. Existing saved weekly menus continue using their stored recipe
snapshots until the planner's explicit **Use current recipes** action.

The new API is `POST /api/meals/with-recipe`. It accepts a UUID `requestId`,
meal metadata and one to fifty ingredient rows. An existing row supplies
`ingredientId` and `quantity`; a new row supplies `name`, `unit` and `quantity`.
It runs under the existing catalog transaction and authorization/audit policy,
and requires no database migration. Administrators and editors can save;
viewers retain read-only access.
