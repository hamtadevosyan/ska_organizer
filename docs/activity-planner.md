# Daily and weekly activity planner

## Everyday use

1. Open **Activity Planner**, choose a room and the Monday of the week, then open a day.
2. Choose **Add activity**, search or choose a suitable saved activity, then check its **Start time** and **End time** and choose **Add to day**.
3. Repeat as needed. **Save week** keeps the schedule; **Print** includes all seven days.

Adding an existing activity takes three button activations from an open day:
**Add activity → Choose [name] → Add to day**. Search and time entry are extra
input. Day view opens by default; **Week view** shows every day. Both retain the
same draft. Day navigation also keeps an unfinished add form and its entered
choices; the new entry is added to the day named by that form. An existing entry
being edited stays on its original day when the view or selected day changes.

The same **Add activity** entry point works with an empty or populated library.
Only activities suitable for the room's complete age range and assignment are
available. Search explains when there is no match. **Create an activity** is a
secondary option: enter its name and usual minutes, then **Save activity & choose
time**. This saves the library activity first. Check the time and choose **Add to
day** to change the weekly draft, then **Save week** to keep that schedule. Closing
the composer does not delete an already saved library activity.

Scheduled activities are readable cards. **Edit** opens a focused form;
**Apply changes** updates the weekly draft, while **Cancel** leaves the entry
unchanged. If the form has changes, choose **Keep editing** or **Discard changes**.
New library forms have their own **Keep editing / Discard activity** choice.
Inline validation keeps entered values and associates the message with its field.
The page shows **Unsaved changes**, **Saved week** or **No schedule saved yet**.

When adding is temporarily unavailable, a message beside the button explains why
and what to do next (finish a catalog edit, refresh activities, finish room setup,
or choose an active room). Read-only accounts keep viewing and printing access.

There is no daily or weekly activity-count limit. Plan arrivals, meals, play,
lessons, rest and departures as activities. Every day, including Saturday and
Sunday, is available. Each room and week has its own schedule.

The first new entry suggests 08:00; later entries suggest the previous end time.
These are editable suggestions, not opening hours. Choosing an activity fills in
its end time from its usual duration; changing the start preserves the current
length. You can change the end separately. For midnight at the end of a day,
choose 00:00 in **End time** (the API stores 24:00). Overnight activities can be entered
on each of the two dates. Times are the room's local wall-clock times.

Activities appear in time order. **Remove** removes only that scheduled entry;
other entries and the activity catalog are kept. **Undo removal** restores the
last removed entry, including its ID, times and saved activity copy. Undo remains
available across day/week views and failed saves, until the next successful week
save or confirmed room/week reload. Repeating an activity or running
activities at the same time is allowed. An overlap is shown beside the entry.
Switching days keeps the current draft. Switching rooms or weeks asks before
losing unsaved changes. The old `/schedule` address opens this same planner.

Earlier morning/midday/afternoon entries are preserved with **Time not set** and
their original block label. No clock times are guessed. Enter their times when
ready; untimed legacy entries may remain in an otherwise timed saved week.

## Add or change an activity

Open **Saved activities → Create library activity** to manage the library separately.
Enter its name and usual duration in minutes, then **Save activity**. This does not
add a scheduled entry or save a week.
Open **More details** when you need instructions, suitable ages or materials.

Ages are in months, like Rooms & Classes. Both can be empty for all ages;
otherwise maximum must exceed minimum. When adding from a selected room,
its valid age range is filled in. Older invalid room ranges are not copied;
new activities start with the optional range empty in that case. Invalid activity
details show a visible error; **More details** opens automatically when a field
inside it needs attention. New activities can be used in any room
whose full age range fits. Older activities assigned to one room retain that restriction.

Open **Saved activities** to find and edit an activity. Saved weeks keep the
name, instructions, usual duration and materials recorded when they were saved.
Moving or resizing a scheduled activity preserves those details. After a catalog
edit, **Use updated activity** applies the new details to that entry, preserving
its chosen times. Save the week afterward. Other entries retain their saved details.

If someone else saves the same week or activity, the server rejects the stale
edit instead of overwriting it. Your entered choices remain available until you
reload or cancel. Reloading a week asks before discarding unsaved changes.
A failed week save can be retried with the same request identifier.

## Materials

Choose materials from Inventory. Enter the amount needed **for the entire
activity and all participating children together**, in the listed stock unit.
Amounts are not multiplied by room capacity, attendance or scheduled duration.

- Supplies that get used up are added across all occurrences that week.
- Check **Can be reused after the activity** for equipment such as toys or brushes.
  The planner counts the greatest combined amount needed at the same time in
  this room. Back-to-back activities can reuse the equipment.
- Earlier entries without clock times are conservatively treated as lasting
  that whole day for reusable equipment checks. Set their times for a better estimate.
- If an item has both uses, required stock is total consumable quantity plus
  the peak reusable quantity.

Expand **Materials check** to see **Needed**, **Available** and **To get** for this room
and week. Stock comes from the chosen inventory item and location; separate
items or locations are not assumed interchangeable. A changed unit or missing
item is flagged for review instead of silently converting it.

Planning, saving, reloading and printing never consume or reserve Inventory.
The estimate does not promise future stock or availability across simultaneous
activities in other rooms. Use Inventory to record real purchases and usage.
**Check materials again** refreshes current availability. While checking or after
a failed check, earlier availability is hidden rather than presented as current.

## Access and printing

Editors and administrators manage activities and schedules. Read-only users
can view schedules, check materials and print. Archived rooms keep their saved
schedules available to view and print, but cannot receive changes.

Print lists every activity in day/time order, including instructions and materials.
It includes the whole week, regardless of which day is open on screen.
Unsaved choices are labeled **Draft — not saved**. Navigation and editing controls
are omitted from the printed page; long schedules continue onto additional pages.

## Storage and API

Migration `012-activity-planner` adds activity duration, month-based ages,
materials and versions; per-entry snapshots; and `ScheduleWeeks` with a unique
room/week key. It preserves existing activity and schedule IDs, imports valid
older year ranges, snapshots existing activities and registers existing weeks.
Unknown legacy duration and material amounts remain unset rather than guessed.

Migration `013-full-day-activities` adds nullable clock times to scheduled entries,
retains earlier untimed blocks without changing their IDs or snapshots, and permits
usual activity durations up to a full day (1,440 minutes). Apply this new migration
even if 012 was already applied; never undo or edit an applied migration.
SKAO-98 changes the client workflow only; it adds no migration or dependency.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/activity` | Saved activity catalog |
| `POST /api/activity` | Create activity |
| `PUT /api/activity/:id` | Edit with the current `version` |
| `GET /api/schedule/plan?roomId=…&weekStart=YYYY-MM-DD` | Read a room/week; empty unsaved weeks have version 0 |
| `POST /api/schedule/plan/preview` | Read-only material calculation using roomId, weekStart, entries and optional version |
| `POST /api/schedule/plan` | Atomic audited save using roomId, weekStart, version, requestId and entries |

Each timed entry contains `id`, `date`, `startTime`, `endTime` and `activityId`.
The client creates a unique ID when adding a row and retains it through edits.
Dates must fall within the selected week; times are HH:MM, with end later than
start. Only end permits 24:00. There is no array-length or per-day count rule.
The same activity can appear multiple times with different entry IDs, including
overlaps. An ID from another room/week is rejected. Legacy entries retain nullable
times and a `timeBlock`; timed entries use `timeBlock: null` or omit it.

Retained entry IDs keep server snapshots. `useLatest: true` and `activityVersion`
explicitly select a catalog revision; a concurrent catalog change is rejected.
Requests never supply trusted snapshot names, actor identity or timestamps.
Materials contain `itemId`, `quantity`, `unit` and `reusable`; names and locations
come from Inventory.

The older array week endpoints remain readable. Their writes default to version
0 and cannot overwrite an existing versioned week without supplying its current
version. Deleting an activity referenced by a saved schedule is rejected.

## Verification after an update

Stop the usual server and client. From the repository root, run:

```bash
bash scripts/check-update.sh
```

Use the full script, without `--inventory`, to include activity coverage.
It backs up the database before migrating and runs the mock API, PostgreSQL,
component and browser suites, plus build and lint checks.

For manual verification, schedule at least five activities in one day. Change times,
remove an entry, undo it, add another, save and reload. Switch Day/Week views
with an unfinished add/edit form and check that its values remain. Validate an
end time before the start, cancel an edit, and check that the saved entry is intact. Check another room/week, weekends,
midnight, the complete printed schedule and any preserved untimed legacy entries.
Create an activity requiring 6 consumable items when stock is 10; scheduling it twice
should show Needed 12 and To get 2. Reusable amounts should add during overlaps but
be reusable afterward. Inventory should remain 10 throughout. Also check catalog
edits and explicit updates, archived rooms, a read-only account and a two-tab conflict.

## Unsaved work when navigating (SKAO-97)

Home, sidebar links, the phone dock and in-app browser Back/Forward now ask
**Keep editing** or **Discard and leave** if a schedule or activity form has
unsaved edits. Keep editing (also Escape or closing the dialog) leaves both drafts
in place. Discard and leave drops unsaved work; already saved catalog activities
stay saved. Navigation never automatically saves a catalog activity or week.
While a save is running, leaving is blocked until its result is known. Failed and
conflicting saves keep the draft and existing version/retry behavior.

Day changes and opening/closing planner details retain drafts. Room/week changes
and Reload week retain their existing discard confirmation. Browser reload/close
retains the native unsaved-change warning; mobile operating systems may terminate
an app without showing it. Drafts are memory-only, so closing/reloading after
confirming discard loses them. Sign-out, expiry and account/role changes clear the
signed-in view and its drafts without delaying account security actions. No
operational data is added to persistent browser storage or the service worker.

Use synthetic records on desktop and iPhone/iPad to check a changed schedule and
an unfinished activity: Home, another module, Back/Forward, phone dock, Keep editing,
Escape, discard, failed/conflicting saves, successful save and readonly navigation.
Verify both drafts together, switch days, and sign out/switch accounts. Reopening
Activities should show saved records, never the previous account's unfinished work.
