import type { Activity, ActivityPlan, Entry } from '../../api/activities';
import { orderedEntries, suitable, weekDates } from '../../api/activities';
import { inventoryRequestId } from '../../api/inventory';
import type { Room } from '../../api/rooms';

export type CopyOptions = {
  mode: 'append' | 'replace';
  idFactory?: () => string;
  // Empty saved days normally leave the destination alone. Clearing is explicit.
  allowEmptyReplace?: boolean;
};
export type CopyResult = { entries: Entry[]; copied: Entry[]; affectedDates: string[] };
export type ReuseAssessment = {
  entryId: string; name: string;
  snapshotUnavailable: boolean; snapshotUnsuitable: boolean;
  catalogUnavailable: boolean; catalogUnsuitable: boolean;
  newerVersionAvailable: boolean; blocked: boolean; message: string;
};

function copyMappedEntries(source: ActivityPlan, destination: Entry[], dates: Map<string, string>, options: CopyOptions): CopyResult {
  const idFactory = options.idFactory || inventoryRequestId;
  const copied: Entry[] = source.entries.filter(entry => dates.has(entry.date)).map(entry => ({
    ...entry, id: idFactory(), date: dates.get(entry.date)!, useLatest: false,
    activity: entry.activity ? { ...entry.activity, materials: entry.activity.materials.map(material => ({ ...material })) } : null,
    // Reference this saved source, even when the source was copied in an earlier week.
    copyFrom: { roomId: source.roomId, weekStart: source.weekStart, version: source.version, entryId: entry.id },
  }));
  const affectedDates = [...new Set(copied.map(entry => entry.date))].sort();
  if (options.mode === 'replace' && options.allowEmptyReplace) {
    for (const date of dates.values()) if (!affectedDates.includes(date)) affectedDates.push(date);
    affectedDates.sort();
  }
  const affected = new Set(affectedDates);
  const retained = options.mode === 'replace' ? destination.filter(entry => !affected.has(entry.date)) : destination;
  return { entries: orderedEntries([...retained, ...copied]), copied: orderedEntries(copied), affectedDates };
}

/** Source entries may already be filtered by the user's selection. */
export function copyDayEntries(source: ActivityPlan, sourceDay: string, destination: Entry[], destinationDay: string, options: CopyOptions): CopyResult {
  return copyMappedEntries(source, destination, new Map([[sourceDay, destinationDay]]), options);
}

/** Map all seven saved source weekdays using UTC dates, including weekends. */
export function copyWeekEntries(source: ActivityPlan, destination: Entry[], destinationWeekStart: string, options: CopyOptions): CopyResult {
  const destinationDates = weekDates(destinationWeekStart);
  const dates = new Map(weekDates(source.weekStart).map((date, index) => [date, destinationDates[index]]));
  return copyMappedEntries(source, destination, dates, options);
}

export function assessReuse(entries: Entry[], room: Room, catalog: Activity[]): ReuseAssessment[] {
  const current = new Map(catalog.map(activity => [activity.id, activity]));
  return entries.map(entry => {
    const latest = current.get(entry.activityId);
    const snapshotUnavailable = !entry.activity || entry.activity.version < 1 || entry.activity.id !== entry.activityId;
    const snapshotUnsuitable = !snapshotUnavailable && !suitable(entry.activity!, room);
    const catalogUnavailable = !latest;
    const catalogUnsuitable = !!latest && !suitable(latest, room);
    const newerVersionAvailable = !!latest && !!entry.activity && latest.version > entry.activity.version;
    const messages: string[] = [];
    if (snapshotUnavailable) messages.push('Saved activity details are unavailable. Choose a replacement or exclude this activity.');
    else if (snapshotUnsuitable) messages.push('Saved activity details do not suit the destination room and its ages. Choose a replacement or exclude this activity.');
    if (catalogUnavailable) messages.push('This activity is no longer in the activity list. Exclude it or choose a replacement.');
    else if (catalogUnsuitable) messages.push('The current activity does not suit the destination room and its ages. Exclude it or choose a replacement.');
    if (newerVersionAvailable) messages.push('A newer version is available. Copying keeps the saved instructions and materials unless you choose the current activity.');
    return { entryId: entry.id, name: entry.activity?.name || 'Unavailable activity', snapshotUnavailable, snapshotUnsuitable,
      catalogUnavailable, catalogUnsuitable, newerVersionAvailable, blocked: snapshotUnavailable || snapshotUnsuitable || catalogUnavailable || catalogUnsuitable, message: messages.join(' ') };
  });
}

/** Moving preserves the exact activity, id, timing and pending copy provenance. */
export function moveEntry(entries: Entry[], entryId: string, destinationDay: string): Entry[] {
  return orderedEntries(entries.map(entry => entry.id === entryId ? { ...entry, date: destinationDay } : entry));
}

/** Timed pairs that actually overlap. Adjacent times and unknown legacy times do not count. */
export function countOverlaps(entries: Entry[]): number {
  let count = 0;
  for (let first = 0; first < entries.length; first++) for (let second = first + 1; second < entries.length; second++) {
    const a = entries[first]; const b = entries[second];
    if (a.date === b.date && a.startTime && a.endTime && b.startTime && b.endTime && a.startTime < b.endTime && b.startTime < a.endTime) count++;
  }
  return count;
}
