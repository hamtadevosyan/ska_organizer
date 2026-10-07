import { describe, expect, test } from 'vitest';
import type { Activity, ActivityPlan, Entry } from '../../api/activities';
import type { Room } from '../../api/rooms';
import { assessReuse, copyDayEntries, copyWeekEntries, countOverlaps, moveEntry } from './planReuse';

const monday = '2030-01-07';
const nextMonday = '2030-01-14';
const activity: Activity = { id: 'art', name: 'Original art', description: 'Original instructions', durationMinutes: 30,
  ageMinMonths: 18, ageMaxMonths: 72, roomId: null, version: 2,
  materials: [{ itemId: 'paint', name: 'Original paint', location: 'Cupboard', quantity: '2.5', unit: 'ml', reusable: false }] };
const room: Room = { id: 'room', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12, active: true,
  needsConfiguration: false, assignedChildCount: 0, availablePlaces: 12, overCapacity: false };
const entry = (values: Partial<Entry> = {}): Entry => ({ id: 'original', date: monday, startTime: '09:00', endTime: '09:30',
  timeBlock: null, activityId: activity.id, activity, useLatest: true, ...values });
const plan = (entries: Entry[] = [entry()]): ActivityPlan => ({ roomId: 'source-room', weekStart: monday,
  version: 3, savedAt: '2030-01-01T12:00:00Z', entries, materials: [] });
const ids = () => { let id = 0; return () => 'copy-' + ++id; };

describe('saved plan copying', () => {
  test('append retains destination entries and clones the saved snapshot instead of substituting the current catalog', () => {
    const source = plan(); const destination = [entry({ id: 'destination', date: nextMonday })];
    const before = JSON.stringify({ source, destination });
    const result = copyDayEntries(source, monday, destination, nextMonday, { mode: 'append', idFactory: ids() });
    expect(result.entries).toHaveLength(2); expect(result.entries).toContain(destination[0]);
    expect(result.copied[0]).toMatchObject({ id: 'copy-1', date: nextMonday, startTime: '09:00', endTime: '09:30',
      activityId: activity.id, activity, useLatest: false,
      copyFrom: { roomId: source.roomId, weekStart: monday, version: 3, entryId: 'original' } });
    expect(result.copied[0].activity).not.toBe(activity);
    expect(result.copied[0].activity!.materials).not.toBe(activity.materials);
    expect(result.copied[0].activity!.materials[0]).not.toBe(activity.materials[0]);
    result.copied[0].activity!.materials[0].quantity = '99';
    expect(JSON.stringify({ source, destination })).toBe(before);
  });

  test('repeated activities receive independent new ids without deduplication', () => {
    const source = plan(Array.from({ length: 5 }, (_, index) => entry({ id: 'source-' + index })));
    const result = copyDayEntries(source, monday, [], nextMonday, { mode: 'append', idFactory: ids() });
    expect(result.copied).toHaveLength(5);
    expect(new Set(result.copied.map(row => row.id)).size).toBe(5);
    expect(result.copied.every(row => row.activityId === activity.id)).toBe(true);
    expect(source.entries.every(row => row.id.startsWith('source-'))).toBe(true);
  });

  test('replace changes only the chosen day and retains all unrelated destination days', () => {
    const tuesday = entry({ id: 'keep', date: '2030-01-15' });
    const result = copyDayEntries(plan([entry(), entry({ id: 'other-source', date: '2030-01-08' })]), monday,
      [entry({ id: 'remove', date: nextMonday }), tuesday], nextMonday, { mode: 'replace', idFactory: ids() });
    expect(result.entries.map(row => row.id)).toEqual(['copy-1', 'keep']);
    expect(result.entries[1]).toBe(tuesday); expect(result.affectedDates).toEqual([nextMonday]);
  });

  test('week copy maps the complete seven days across a year boundary without timezone shifts', () => {
    const source: ActivityPlan = { ...plan(), weekStart: '2029-12-31', entries: Array.from({ length: 7 }, (_, index) =>
      entry({ id: 'day-' + index, date: index === 0 ? '2029-12-31' : '2030-01-0' + index })) };
    const result = copyWeekEntries(source, [], '2030-03-04', { mode: 'append', idFactory: ids() });
    expect(result.copied.map(row => row.date)).toEqual(['2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08', '2030-03-09', '2030-03-10']);
    expect(result.copied).toHaveLength(7);
    expect(result.copied.at(-1)).toMatchObject({ startTime: '09:00', endTime: '09:30' });
  });

  test('selected week rows replace only days that actually contain selected source entries', () => {
    const keep = entry({ id: 'tuesday', date: '2030-01-15' });
    const result = copyWeekEntries(plan(), [entry({ id: 'monday', date: nextMonday }), keep], nextMonday,
      { mode: 'replace', idFactory: ids() });
    expect(result.entries.map(row => row.id)).toEqual(['copy-1', 'tuesday']);
    expect(result.entries[1]).toBe(keep); expect(result.affectedDates).toEqual([nextMonday]);
  });

  test.each(['append', 'replace'] as const)('an empty source cannot silently clear destination in %s mode', mode => {
    const destination = [entry({ id: 'keep', date: nextMonday })];
    expect(copyDayEntries(plan([]), monday, destination, nextMonday, { mode }).entries).toEqual(destination);
    expect(copyWeekEntries(plan([]), destination, nextMonday, { mode }).entries).toEqual(destination);
    expect(copyWeekEntries(plan([]), destination, nextMonday, { mode }).affectedDates).toEqual([]);
  });

  test('clearing an empty destination day is explicit and never removes unrelated days', () => {
    const keep = entry({ id: 'keep', date: '2030-01-15' });
    const result = copyDayEntries(plan([]), monday, [entry({ date: nextMonday }), keep], nextMonday,
      { mode: 'replace', allowEmptyReplace: true });
    expect(result.entries).toEqual([keep]); expect(result.affectedDates).toEqual([nextMonday]);
  });

  test('midnight and legacy untimed entries retain their exact timing', () => {
    const result = copyDayEntries(plan([entry({ id: 'midnight', startTime: '23:30', endTime: '24:00' }),
      entry({ id: 'legacy', startTime: null, endTime: null, timeBlock: 'afternoon' })]), monday, [], nextMonday,
      { mode: 'append', idFactory: ids() });
    expect(result.copied[0]).toMatchObject({ startTime: '23:30', endTime: '24:00', timeBlock: null });
    expect(result.copied[1]).toMatchObject({ startTime: null, endTime: null, timeBlock: 'afternoon' });
  });


  test('copying an already copied saved week references the immediately selected saved source', () => {
    const first = copyDayEntries(plan(), monday, [], nextMonday, { mode: 'append', idFactory: ids() });
    const savedCopy: ActivityPlan = { ...plan(first.copied), roomId: 'second-room', weekStart: nextMonday, version: 4 };
    const second = copyDayEntries(savedCopy, nextMonday, [], '2030-01-21', { mode: 'append', idFactory: () => 'second-copy' });
    expect(second.copied[0]).toMatchObject({ copyFrom: {
      roomId: 'second-room', weekStart: nextMonday, version: 4, entryId: 'copy-1',
    } });
    expect(second.copied[0].activity).toEqual(first.copied[0].activity);
    expect(second.copied[0].activity).not.toBe(first.copied[0].activity);
  });

  test('entries outside the selected saved week cannot be pulled into a week copy', () => {
    const result = copyWeekEntries(plan([entry(), entry({ id: 'outside', date: '2030-01-14' })]), [], nextMonday,
      { mode: 'append', idFactory: ids() });
    expect(result.copied).toHaveLength(1); expect(result.copied[0].date).toBe(nextMonday);
  });
});

describe('reuse review', () => {
  test('a newer unsuitable catalog version blocks copying without changing the saved snapshot', () => {
    const latest = { ...activity, name: 'New art', ageMinMonths: 72, ageMaxMonths: 120, version: 4, materials: [] };
    const result = assessReuse([entry()], room, [latest]);
    expect(result[0]).toMatchObject({ snapshotUnavailable: false, snapshotUnsuitable: false,
      catalogUnavailable: false, catalogUnsuitable: true, newerVersionAvailable: true, blocked: true });
    expect(result[0].message).toContain('keeps the saved instructions and materials');
    expect(activity.name).toBe('Original art'); expect(activity.materials).toHaveLength(1);
  });


  test('an eligible newer catalog version is informational and never replaces the saved snapshot', () => {
    const latest = { ...activity, name: 'New art', version: 4, materials: [] };
    expect(assessReuse([entry()], room, [latest])[0]).toMatchObject({ newerVersionAvailable: true, blocked: false });
    expect(activity.name).toBe('Original art'); expect(activity.materials).toHaveLength(1);
  });

  test('a missing current catalog entry blocks copying despite usable saved details', () => {
    expect(assessReuse([entry()], room, [])[0]).toMatchObject({ catalogUnavailable: true,
      snapshotUnavailable: false, snapshotUnsuitable: false, blocked: true, newerVersionAvailable: false });
  });

  test.each([null, { ...activity, version: 0 }, { ...activity, id: 'different-id' }])('unavailable saved details must be replaced or excluded', snapshot => {
    const result = assessReuse([entry({ activity: snapshot })], room, [activity])[0];
    expect(result).toMatchObject({ snapshotUnavailable: true, blocked: true, catalogUnavailable: false });
    expect(result.message).toContain('Choose a replacement or exclude');
  });

  test.each([{ ...activity, roomId: 'another-room' }, { ...activity, ageMinMonths: 60, ageMaxMonths: 72 }])('saved room or age restrictions block copying', snapshot => {
    expect(assessReuse([entry({ activity: snapshot })], room, [activity])[0]).toMatchObject({ snapshotUnsuitable: true, blocked: true });
  });

  test('a room with unknown ages cannot use an age-restricted snapshot', () => {
    expect(assessReuse([entry()], { ...room, ageMinMonths: null, ageMaxMonths: null }, [activity])[0].blocked).toBe(true);
    expect(assessReuse([entry({ activity: { ...activity, ageMinMonths: null, ageMaxMonths: null } })], room, [activity])[0].blocked).toBe(false);
  });
});

describe('move and timing review', () => {
  test('move changes only date and retains the same identity, exact snapshot and pending update choice', () => {
    const source = entry(); const other = entry({ id: 'other', date: nextMonday });
    const result = moveEntry([source, other], source.id, '2030-01-08');
    expect(result[0]).toEqual({ ...source, date: '2030-01-08' });
    expect(result[0].activity).toBe(source.activity); expect(result[1]).toBe(other); expect(source.date).toBe(monday);
  });

  test('move retains a pending copied snapshot provenance without generating another identity', () => {
    const copied = copyDayEntries(plan(), monday, [], nextMonday, { mode: 'append', idFactory: ids() }).copied[0];
    const moved = moveEntry([copied], copied.id, '2030-01-15')[0];
    expect(moved).toEqual({ ...copied, date: '2030-01-15' }); expect(moved.activity).toBe(copied.activity);
  });

  test('overlap review counts pairs but permits adjacent times, another date and untimed entries', () => {
    const rows = [entry(), entry({ id: 'overlap', startTime: '09:15', endTime: '09:45' }),
      entry({ id: 'adjacent', startTime: '09:45', endTime: '10:00' }),
      entry({ id: 'another-day', date: '2030-01-08' }), entry({ id: 'untimed', startTime: null, endTime: null, timeBlock: 'morning' })];
    expect(countOverlaps(rows)).toBe(1);
    expect(countOverlaps([entry({ startTime: '23:30', endTime: '24:00' }), entry({ id: 'late', startTime: '23:45', endTime: '24:00' })])).toBe(1);
  });
});
