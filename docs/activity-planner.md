# Daily and weekly activity planner

## Everyday use

1. Open **Activity Planner** and choose a room and the Monday of the week.
2. Choose a day, then **+ Add to day**. Pick an activity and its **Start** and **End** times.
3. Add as many activities as the day needs. Click **Save week**, or **Print** for a paper copy.

If no saved activities match the room yet, **+ Add to day** opens a short form.
Enter the activity name and minutes, then **Add to day**. The new activity is saved
and placed directly on the selected day; save the week to keep the schedule.

You can switch days while filling in that form. Its heading changes to the new
day, and your entered details stay in place. **Continue activity** returns focus
to the open form. Day changes pause only while the activity is being saved.
**Cancel** shows **Keep editing** and **Discard activity** when you have typed
details. Discarding that form leaves the rest of the weekly schedule intact.

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
choose 00:00 in **End** (the API stores 24:00). Overnight activities can be entered
on each of the two dates. Times are the room's local wall-clock times.

Activities appear in time order. **Remove** removes only that scheduled entry;
other entries and the activity catalog are kept. Repeating an activity or running
activities at the same time is allowed. An overlap is shown beside the entry.
Switching days keeps the current draft. Switching rooms or weeks asks before
losing unsaved changes. The old `/schedule` address opens this same planner.

Earlier morning/midday/afternoon entries are preserved with **Time not set** and
their original block label. No clock times are guessed. Enter their times when
ready; untimed legacy entries may remain in an otherwise timed saved week.

## Add or change an activity

Choose **Add activity**, enter its name and usual duration in minutes, then save.
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

The materials table shows **Needed**, **Available** and **To get** for this room
and week. Stock comes from the chosen inventory item and location; separate
items or locations are not assumed interchangeable. A changed unit or missing
item is flagged for review instead of silently converting it.

Planning, saving, reloading and printing never consume or reserve Inventory.
The estimate does not promise future stock or availability across simultaneous
activities in other rooms. Use Inventory to record real purchases and usage.
**Check materials again** refreshes current availability.

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
remove an entry, add another, save and reload. Check another room/week, weekends,
midnight, the complete printed schedule and any preserved untimed legacy entries.
Create an activity requiring 6 consumable items when stock is 10; scheduling it twice
should show Needed 12 and To get 2. Reusable amounts should add during overlaps but
be reusable afterward. Inventory should remain 10 throughout. Also check catalog
edits and explicit updates, archived rooms, a read-only account and a two-tab conflict.
