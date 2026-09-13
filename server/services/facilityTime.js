const { problem } = require('./planValidation');
const formatters = new Map();
function timeZone() {
  const zone = process.env.FACILITY_TIME_ZONE || 'America/Los_Angeles';
  try {
    if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  } catch { throw new Error('FACILITY_TIME_ZONE must be a valid IANA time zone, such as America/Los_Angeles.'); }
  return zone;
}
function localTime(value, zone = timeZone()) {
  timeZone();
  const formatter = formatters.get(zone) || new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
const dateAt = (value = new Date(), zone = timeZone()) => localTime(value, zone).slice(0, 10);
function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01') throw problem('Use a date in YYYY-MM-DD format.');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw problem('Choose a real calendar date.');
  return value;
}
function addDays(value, count) {
  const date = new Date(validateDate(value) + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
// Find each local date boundary independently: a facility day may have 23 or 25 hours.
function startOfDate(value, zone) {
  const guess = Date.parse(value + 'T00:00:00Z');
  let low = guess - 36 * 3600000;
  let high = guess + 36 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (dateAt(middle, zone) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
function dayBounds(value, zone = timeZone()) {
  validateDate(value);
  const start = startOfDate(value, zone);
  if (dateAt(start, zone) !== value) throw problem('This calendar date does not occur in the facility time zone.');
  return { from: new Date(start).toISOString(), to: new Date(startOfDate(addDays(value, 1), zone)).toISOString() };
}
// Corrections accept an offset-qualified instant or a facility-local wall time.
// Never silently pick one occurrence of an ambiguous daylight-saving time.
function resolveTime(value, occurrence) {
  if (typeof value !== 'string') throw problem('Enter an attendance date and time.');
  validateDate(value.slice(0, 10));
  if (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const instant = new Date(value);
    if (Number.isFinite(instant.getTime())) return instant.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) throw problem('Enter a valid facility-local time or an ISO timestamp with an offset.');
  const target = value.length === 16 ? value + ':00' : value;
  const guess = Date.parse(target + 'Z');
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = guess + hours * 3600000;
    offsets.add(Date.parse(localTime(sample) + 'Z') - sample);
  }
  const choices = [...offsets].map((offset) => guess - offset).filter((instant) => localTime(instant) === target).sort((a, b) => a - b);
  if (!choices.length) throw problem('That local time does not exist because the clocks moved forward. Choose another time.');
  if (choices.length > 1 && !['earlier', 'later'].includes(occurrence)) throw problem('That time occurs twice because the clocks moved back. Choose its first or second occurrence.');
  return new Date(occurrence === 'later' ? choices.at(-1) : choices[0]).toISOString();
}
module.exports = { timeZone, dateAt, localTime, validateDate, addDays, dayBounds, resolveTime };
