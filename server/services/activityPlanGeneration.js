const { randomUUID } = require('node:crypto');
const { problem } = require('./planValidation');
const { dateOnly } = require('./roomValidation');
const v = require('./activityValidation');

const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const formatClock = (value) => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
const overlaps = (first, second) => first.date === second.date &&
  (!second.startTime || minutes(first.startTime) < minutes(second.endTime) && minutes(first.endTime) > minutes(second.startTime));

function slots(values, weekStart) {
  if (!Array.isArray(values) || !values.length || values.length > 140) throw problem('Choose between 1 and 140 activity slots to generate.');
  const end = new Date(weekStart + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 7);
  const seen = new Set();
  return values.map((slot) => {
    v.object(slot, ['id', 'date', 'startTime', 'endTime']); v.identifier(slot.id, 'slots'); dateOnly(slot.date);
    if (seen.has(slot.id)) throw problem('Each generation slot needs a different identifier.');
    seen.add(slot.id);
    if (slot.date < weekStart || slot.date >= end.toISOString().slice(0, 10)) throw problem('Choose slot dates within the selected week.');
    if (typeof slot.startTime !== 'string' || !clock.test(slot.startTime) || typeof slot.endTime !== 'string' ||
        !clock.test(slot.endTime) && slot.endTime !== '24:00' || slot.endTime <= slot.startTime) {
      throw problem('Enter valid slot times, with the latest end after the start on the same day.');
    }
    return { id: slot.id, date: slot.date, startTime: slot.startTime, endTime: slot.endTime };
  }).sort((a, b) => (a.date + a.startTime + a.id).localeCompare(b.date + b.startTime + b.id));
}
function identifiers(values, label) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 1000) throw problem('Supply up to 1,000 ' + label + ' identifiers.');
  values.forEach((id) => v.identifier(id, label));
  if (new Set(values).size !== values.length) throw problem('Supply each ' + label + ' identifier only once.');
  return values;
}
function generate({ room, catalog, history, entries, selectedSlots, allowRepeats, excludeActivityIds }) {
  const eligible = catalog.filter((activity) => v.suitable(activity, room));
  const complete = eligible.filter((activity) => Number.isInteger(activity.durationMinutes) && activity.durationMinutes > 0 && activity.durationMinutes <= 1440);
  const excluded = new Set(excludeActivityIds);
  const candidates = complete.filter((activity) => !excluded.has(activity.id));
  const lastUsed = new Map(history.map((row) => [row.activityId, row.lastUsed]));
  const uses = new Map();
  entries.forEach((entry) => uses.set(entry.activityId, (uses.get(entry.activityId) || 0) + 1));
  const planned = [...entries]; const generated = []; const generatedSlots = []; const unfilledSlots = []; const warnings = [];
  if (complete.length < eligible.length) warnings.push((eligible.length - complete.length) + ' suitable activities were skipped because their duration is missing or invalid. Update their catalog details to include them.');
  for (const slot of selectedSlots) {
    const choices = candidates.filter((activity) => allowRepeats || !uses.has(activity.id));
    const fits = choices.filter((activity) => activity.durationMinutes <= minutes(slot.endTime) - minutes(slot.startTime));
    const available = fits.filter((activity) => !planned.some((entry) => overlaps({ ...slot, endTime: formatClock(minutes(slot.startTime) + activity.durationMinutes) }, entry)));
    available.sort((a, b) => (uses.get(a.id) || 0) - (uses.get(b.id) || 0) ||
      (lastUsed.get(a.id) || '').localeCompare(lastUsed.get(b.id) || '') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const chosen = available[0];
    if (!chosen) {
      const reason = !candidates.length ? 'No eligible activities are available. Add suitable activities with a duration or review your exclusions.' :
        !choices.length ? 'No unused activities remain. Add more suitable activities or allow repeats.' :
        !fits.length ? 'No activity fits this time window. Extend the latest end or add shorter activities.' :
        'This slot overlaps an existing activity. Change its time or choose an explicit replacement.';
      unfilledSlots.push({ ...slot, reason });
      continue;
    }
    const entry = { id: randomUUID(), date: slot.date, startTime: slot.startTime,
      endTime: formatClock(minutes(slot.startTime) + chosen.durationMinutes), timeBlock: null,
      activityId: chosen.id, activity: v.snapshot(chosen), useLatest: true, activityVersion: chosen.version };
    generated.push(entry); planned.push(entry); uses.set(chosen.id, (uses.get(chosen.id) || 0) + 1);
    generatedSlots.push({ slotId: slot.id, entryId: entry.id });
    if (chosen.materialsNotes && !chosen.materials?.length || chosen.materialsLinks?.length && !chosen.materials?.length) {
      warnings.push(chosen.name + ' has material notes or links without inventory quantities. Its material availability cannot be checked.');
    }
  }
  return { generated, generatedSlots, unfilledSlots, warnings: [...new Set(warnings)] };
}
module.exports = { slots, identifiers, generate, overlaps };
