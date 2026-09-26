# Start here — SKAO-66 planner review

This ZIP contains a **clickable workflow proposal**, with the approved Bloom
colors and academy logo. It is not an app update. Your installed application
will look the same until a later implementation is delivered.

## Open it

1. Extract `SKAO-66-planner-review.zip` into a new folder.
2. Double-click **planner-review.html** and open it in Chrome, Edge or Firefox.
   Open the downloaded file in a browser if ChatGPT only shows a static preview.
3. No login, npm, database, server or internet connection is needed. All examples
   are fictional. Do not enter real child or staff information into a review file.

The logo and font are included in the HTML. Changes and **Save week** last only
while this tab is open; refreshing restores the starting examples. There is no
connection to your app and no persistent browser storage.

## Try these five things

1. **Read a full day.** Rainbow / Sep 28 starts on Monday with 14 activities.
   Switch between Day and Week. Open Instructions on a scheduled activity.
2. **Add and change something.** Open Tuesday → Add activity → choose Story
   adventures → adjust its time → Add to Tuesday. Use Edit to move it to
   Wednesday. Try Remove from day and Undo. Then Save week.
3. **Reuse a plan.** Choose the Oct 5 week → Copy a week. Read the preview and
   copy the previous saved week's activities into empty days. Existing days
   stay as they are. You can Undo before saving. Copy another day demonstrates
   adding a routine to one day; it can intentionally create overlapping times.
4. **Check recovery.** Expand Review controls & limits. Make the next Save week
   fail, change a scheduled time, then Save week. Your changes remain; retry.
   Try leaving with unsaved work, or Reload saved week, and test Keep editing.
5. **Read and print.** Toggle View as read-only staff. Editing disappears and
   the last saved example appears. Turn it off to return to your draft. Print
   week includes all seven days and labels unsaved content as a draft.

Also try creating an activity: Cancel should ask before discarding typed details.
The proposal keeps the real app's two save boundaries visible: **Save activity &
add** creates the library item, then **Save week** saves the schedule.

## Tell me how you normally plan

**Do you usually copy last week and change a few activities, or create each
week from scratch?** Try that routine here and tell me the first point that
feels confusing or takes unnecessary work.

We also need to settle whether staff see every saved plan or only a separately
approved plan. The read-only example shows saved data; approval/publishing has
not been designed yet.

## What is included

- `planner-review.html` — self-contained clickable proposal.
- `REVIEW.md` — source findings, proposed flows, preservation requirements,
  usability targets and linked Jira work.
- `SKAO-66-review.patch` — optional repository documentation/prototype source.
- `PlusJakartaSans-OFL.txt` — bundled font license.
- `CHECKSUMS.sha256` — package file checksums.

Prototype interactions were checked in a DOM environment, and the existing app's
16 Activity Planner tests passed. Real-browser appearance, keyboard/touch behavior
and printed page layout still need your review. Inventory calculations, real
authentication, concurrent edits and backend persistence are not simulated.

## Optional: keep the review files in Git

You do **not** need to apply a patch to try the HTML. This patch adds only review
documentation and prototype source; it does not change production UI behavior.
It is based on development commit `1fb6eb7`, after your SKAO-96 merge (PR #16).

From a clean local repository in PowerShell, with the extracted review folder
beside the repository:

```powershell
git status --short
git switch development
git pull --ff-only
git switch -c feature/SKAO-66-planner-review
git apply --check "../SKAO-66-planner-review/SKAO-66-review.patch"
git apply --index "../SKAO-66-planner-review/SKAO-66-review.patch"
git diff --cached --stat
```

If `git status --short` lists existing changes, finish or preserve that work
before switching branches. If patch checking reports a conflict, stop and share
the message; do not force-apply it. Adjust the patch path if you extracted the
ZIP elsewhere.

To rebuild the self-contained HTML from the source using Node:

```powershell
node docs/prototypes/skao-66/build-preview.cjs ../planner-review.html
```

After reviewing, you can commit and publish the documentation branch:

```powershell
git commit -m "SKAO-66: document planner review and clickable proposal"
git push -u origin feature/SKAO-66-planner-review
```

Open a PR into `development` if you want to retain these review files. There is
no pilot update or migration to run for this package. The proposed application
changes are recorded separately as SKAO-97, SKAO-98 and SKAO-99; SKAO-66 remains
In Progress for the workflow review.
