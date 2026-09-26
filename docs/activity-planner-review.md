# SKAO-66 — Activity Planner workflow review

Status: review started; owner walkthrough pending. Baseline: `development` at
`1fb6eb7` (SKAO-96 merged in PR #16). The production planner is unchanged by this
review package. Proposed behavior below is not a claim that it is already in
the application.

## What we know

The owner wants a planner that busy childcare staff can understand with minimal
effort and no training. A full day must allow any number of activities, including
arrival, meals, rest and departure. The approved Bloom design provides the
visual direction: cheerful colors, clear icons, the original academy crest and
locally bundled assets.

Earlier recorded access preferences distinguish authorized people who manage
activities from staff who view the resulting plans. Current application roles
are admin/editor/viewer. There is no draft/published approval state in the current
ActivityPlan model. Do not invent a publishing workflow or change role rights
without settling what “final plan” means to the owner.

The owner's actual daily/weekly routine is still unconfirmed: whether they
usually reuse last week, start with a daily routine, or create each week from
scratch. The prototype offers both day and week views to make that discussion
concrete. Sample hours, activities and room ages are fictional review data, not
assumptions about the academy's schedule or recommended care routines.

## Current behavior and proposed changes

| Area | Evidence in the current app | Proposed direction |
| --- | --- | --- |
| Full day | Unlimited timed entries across all seven days already work. | Preserve this; do not reintroduce fixed blocks or count limits. |
| Add | Header **Add activity** manages the catalog. **Add to day** inserts a blank row or opens creation, depending on available choices. | One scheduling entry point opens searchable suitable activities, with **Create an activity** as a secondary choice. |
| Create and save | Catalog items save immediately; the schedule needs a separate **Save week**. Creation appears above room/week controls. | Keep creation near the selected day. Say **Save activity & add**, explain that it saves to the library, and keep weekly save status visible. |
| Read and edit | Every scheduled row shows start/end inputs and an activity select. | Show a scannable timeline; **Edit** opens a focused form. Keep explicit latest-version updates in the eventual implementation. |
| Reuse/move | There are no copy-day, copy-week or change-entry-date operations in the hook/UI. | Preview copying a day or week, keep destination work by default, and offer a day selector when editing. |
| Remove | Removes the scheduled entry immediately. | Provide undo before saving. Never delete the catalog item as a side effect. |
| Drafts | Day changes retain work; room/week/reload changes ask before discard. A beforeunload warning protects browser reload/close. | Retain or explicitly protect drafts during in-app navigation. The prototype retains room/week drafts in memory and demonstrates a leave prompt. |
| In-app navigation | Sidebar/dock links use React Router; planner/form state lives inside the page; no route blocker or retained page state was found. | Prioritize this potential lost-work path. Verify browser Back/Forward and route links in implementation. This finding is from source inspection, not a live-browser reproduction. |
| Materials | Existing preview computes shortages; failed checks clear stale quantities. Stock is never consumed/reserved by planning. | Keep the check expandable and its recovery obvious. Preserve arithmetic and snapshot semantics. |
| Read-only/print | Viewer and archived-room schedules can be viewed/printed. Full-week print includes all entries and marks unsaved drafts. | Preserve these abilities while simplifying visual presentation. |

Source files reviewed: `client/src/pages/Activities.tsx`,
`client/src/components/activities/{ActivityDay,ActivityForm,ActivityPrint,useActivityPlanner}.tsx/ts`,
`client/src/api/activities.ts`, `client/src/App.tsx`, `client/src/router/index.tsx`,
`client/src/components/Sidebar.tsx`, and `docs/activity-planner.md`.

## Concrete proposed flows

**Plan a full day:** choose room/week → open a day → **Add activity** → choose a
saved activity → confirm its time → **Save week**. Repeat as often as needed.
The initial example contains 14 activities from 7:30 AM to 5:30 PM. These are
sample values, not limits. **Create an activity** covers empty or unmatched
search results. New items default to the selected room's ages; detailed age and
inventory editing remain requirements for the real catalog form.

**Change an existing week:** open the Week view → open a day → **Edit** an entry
→ change times or move it to another day → apply → review the visible unsaved
state → **Save week**. **Remove from day** has undo. Day/Week switches retain
changes; creating an unfinished activity has an explicit keep/discard choice.

**Reuse a routine:** **Copy a week** previews the previous saved week's source,
destination, counts and affected days. This prototype demonstrates the
conservative choice of filling empty destination days only. **Copy another
day** adds entries to the chosen day and explicitly warns that times can
overlap. Both are reversible draft changes until saved. More general source-week
selection and replacement choices belong in the follow-up story after the
owner confirms the routine.

**Recover:** failed save keeps the draft and offers retry. Reload asks before
discarding changes. The leave example offers Keep editing, Discard changes, or
Save & continue; failed save does not continue. This is a standalone simulation,
not an implemented React Router guard.

## Observable usability targets to review

- A first-time user can identify the room, week, selected day, Add activity and
  Save week without coaching. Verify with a real walkthrough; this has not yet
  been measured.
- Adding a saved activity takes three button activations from an open day:
  Add activity → choose activity → Add to day. Search/time entry are additional
  input, and saving the whole week is a separate explicit action.
- Create a full-day plan with more than ten entries, then add another; no
  count-limit message or forced fixed-day blocks appear.
- After changing an entry, switch day/view/room/week and return: no typed draft
  is silently lost. Leaving the planner has an explicit recovery path.
- A save error explains what happened and how to retry; the entered schedule
  stays visible. A conflict never overwrites another user's work silently.
- Copy preview names the source/destination and affected days; cancel changes
  nothing. Existing destination work is preserved by default.
- Staff can read instructions and print the whole week; viewers have no write
  controls. Color always has an accompanying text label or icon.
- Check 375 px phone, tablet and desktop layouts, keyboard focus, modal cancel,
  long names and print continuation on real browsers. Target native controls
  at least 44 px tall. The prototype has responsive rules; actual rendering
  still needs review.

## Requirements carried into implementation

Preserve legacy untimed entries, entry IDs on moves, saved activity snapshots,
explicit activity-version updates, retry IDs and room/week version checks.
Copies need new IDs and an explicit snapshot policy; do not silently substitute
new catalog versions. Flag missing or age-incompatible activities without
erasing earlier schedules. Keep archived rooms and account permissions explicit.

Consumables total across occurrences; reusable materials use peak simultaneous
need within the room. Quantities are for the whole activity, not multiplied by
attendance. Planning, saving, copying and printing must never consume or reserve
stock. Cross-room stock availability is not guaranteed by the current preview.

Draft protection must not introduce persistent storage of operational data in
the browser or service-worker API caching. Coordinate with SKAO-79. Local model
integration and hardware/network changes are outside this review.

## Prioritized linked follow-ups

| Order | Issue | Priority | Scope |
| --- | --- | --- | --- |
| 1 | [SKAO-97](https://ska-organizer.atlassian.net/browse/SKAO-97) | High | Protect unsaved planner/form work during navigation and failed saves. |
| 2 | [SKAO-98](https://ska-organizer.atlassian.net/browse/SKAO-98) | High | Simplify add/edit/save using Bloom, preserve existing planner behavior, and coordinate responsive work with SKAO-77. |
| 3 | [SKAO-99](https://ska-organizer.atlassian.net/browse/SKAO-99) | Medium | Copy days/weeks and move entries with preview, identity/snapshot rules and undo. |

All three are To Do and relate to SKAO-66. They were not added to Sprint 1 and
have no new deadline. Their workflow choices remain proposals pending owner
review; priority expresses the recommended order, not a delivery commitment.

## Verification and limits

- Existing Activity Planner component suite: **16/16 passed** on this baseline.
- Standalone prototype JavaScript parses; DOM interaction checks passed for
  full-day and week views, add/validation, room/week draft retention, age-filtered
  search, cancel/keep/discard, move/remove/undo, save/reload, copy day/week,
  read-only display, failed save, leave confirmation, midnight and full-week
  draft print content. Checking exposed an undo-access issue after switching
  views; the prototype now keeps Undo in the bottom action bar until saving.
- Logo and font are embedded. No network requests, analytics, external asset
  URLs, localStorage or sessionStorage are used. A content security policy blocks
  network connections. All sample state is in this tab's memory and resets on
  refresh. “Save” is deliberately labelled as a prototype action.
- DOM checks are not browser layout, touch, native dialog or print-rendering
  verification. No real server/database, permissions or stock calculation is
  exercised by the prototype. It is not a production security boundary.
- No production application code, dependencies, migration or deployment changed.
  SKAO-66 remains In Progress until the owner reviews the concrete flow and the
  remaining routine/approval questions are recorded.

## Owner walkthrough still needed

Start with the supplied **START-HERE.md** and **planner-review.html**. The main
question is: **When preparing a new week, do you usually copy the previous week
and change a few activities, or build the plan from scratch?** A short example
of the real routine is more useful than approving the look alone.

During that walkthrough, also confirm whether staff should see any saved plan
immediately or only a separately approved/published version. The prototype's
read-only view shows saved example data; it does not settle that policy.
