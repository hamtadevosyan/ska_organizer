const db = require('./dbAdapter');
const time = require('./facilityTime');
const { problem } = require('./planValidation');
const { amount, decimal } = require('./inventoryValidation');
const MAX_DAYS = 366;
const MAX_ROWS = 50000;
const offsetFormatters = new Map();
const columns = (pairs) => pairs.map(([key, label]) => ({ key, label }));
const attendanceColumns = columns([
  ['date', 'Visit start date'], ['child', 'Child'], ['room', 'Room'],
  ['checkIn', 'Check-in'], ['checkOut', 'Check-out'], ['status', 'Status'],
]);
const purchaseColumns = columns([
  ['date', 'Received date'], ['item', 'Item'], ['group', 'Group'], ['location', 'Location'],
  ['quantity', 'Quantity'], ['unit', 'Unit'], ['supplier', 'Supplier'], ['totalCost', 'Total cost'], ['currency', 'Currency'],
]);

function filters(kind, query) {
  const allowed = ['from', 'to', ...(kind === 'attendance' ? ['roomId'] : [])];
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some((key) => !allowed.includes(key))) {
    throw problem('Use only the report date range and optional attendance room.');
  }
  let from, to;
  try { from = time.validateDate(query.from); to = time.validateDate(query.to); }
  catch { throw problem('Choose a valid start and end date.'); }
  if (from > to) throw problem('The end date must be on or after the start date.');
  if (to === '9999-12-31') throw problem('Choose an end date before 9999-12-31.');
  if ((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000 + 1 > MAX_DAYS) {
    throw problem('Choose a range of up to 366 days.');
  }
  let roomId = null;
  if (query.roomId !== undefined) {
    if (typeof query.roomId !== 'string' || !query.roomId.trim() || query.roomId.length > 255) throw problem('Choose a valid room.');
    roomId = query.roomId.trim();
  }
  return { from, to, roomId };
}
function checkSize(rows) {
  if (rows.length > MAX_ROWS) throw problem('This report has more than 50,000 records. Choose a shorter date range.');
}
function timestamp(value, zone) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Not recorded';
  if (!offsetFormatters.has(zone)) offsetFormatters.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }));
  const offset = offsetFormatters.get(zone).formatToParts(new Date(value)).find((part) => part.type === 'timeZoneName').value;
  return time.localTime(value, zone).replace('T', ' ') + ' ' + offset;
}
const base = (kind, filter, now, zone) => ({
  kind, title: kind === 'attendance' ? 'Attendance report' : 'Purchasing report', filters: filter,
  timeZone: zone, generatedAt: now.toISOString(), generatedLabel: timestamp(now, zone),
});
exports.config = async () => ({ today: time.dateAt(), timeZone: time.timeZone(), maxRangeDays: MAX_DAYS,
  rooms: (await db.listRooms({ includeArchived: true })).map(({ id, name, active }) => ({ id, name, active })),
});

async function attendance(filter) {
  return db.withRoomLock(async () => {
    const now = new Date(); const zone = time.timeZone();
    const rooms = await db.listRooms({ includeArchived: true });
    const selected = filter.roomId && rooms.find((row) => row.id === filter.roomId);
    if (filter.roomId && !selected) throw problem('That room is unavailable. Refresh the report settings and choose another room.');
    const [records, undated] = await Promise.all([
      db.listReportAttendance({ from: time.dayBounds(filter.from, zone).from, to: time.dayBounds(filter.to, zone).to,
        roomId: filter.roomId, limit: MAX_ROWS + 1 }),
      db.countUndatedAttendance({ roomId: filter.roomId }),
    ]);
    checkSize(records);
    const children = new Map((await db.listReportChildren([...new Set(records.map((row) => row.childId))]))
      .map((row) => [row.id, [row.firstName, row.lastName].filter(Boolean).join(' ') || 'Name not recorded']));
    const roomNames = new Map(rooms.map((row) => [row.id, row.name]));
    const today = time.dateAt(now, zone);
    const rows = records.map((row) => {
      const date = time.dateAt(row.checkIn, zone);
      const review = row.needsReview || new Date(row.checkIn) > now ||
        (row.checkOut ? new Date(row.checkOut) < new Date(row.checkIn) || new Date(row.checkOut) > now : date < today);
      return {
        id: row.id, date, child: children.get(row.childId) || 'Child record unavailable',
        room: roomNames.get(row.roomId) || (row.roomId ? 'Room record unavailable' : 'Not recorded'),
        checkIn: timestamp(row.checkIn, zone), checkOut: row.checkOut ? timestamp(row.checkOut, zone) : 'Not recorded',
        status: row.voided ? 'Voided' : review ? 'Needs review' : row.checkOut ? 'Checked out' : 'Open',
      };
    });
    const included = records.filter((row) => !row.voided);
    const notes = [
      'Each visit overlapping the selected dates appears once. Check-in and check-out show the full recorded times.',
      'Voided visits remain visible and are excluded from visit and child totals. Names reflect the current child and room records; room assignments come from each visit.',
    ];
    if (undated) notes.push(`${undated} non-voided attendance record(s) in ${selected ? 'this room' : 'all rooms'} have no check-in date and cannot be assigned to a date range. Review them in Attendance.`);
    return { ...base('attendance', { ...filter, roomName: selected ? selected.name : 'All rooms' }, now, zone),
      columns: attendanceColumns, rows, notes,
      summary: [
        { label: 'Recorded visits', value: String(included.length) },
        { label: 'Children with visits', value: String(new Set(included.map((row) => row.childId)).size) },
        { label: 'Visits without check-out', value: String(included.filter((row) => !row.checkOut).length) },
        { label: 'Needs review', value: String(rows.filter((row) => row.status === 'Needs review').length) },
        { label: 'Voided visits', value: String(records.length - included.length) },
      ],
    };
  });
}
// Decimal costs stay exact, including a true recorded zero; null is never converted to zero.
function cents(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value))) throw new Error('Invalid stored purchase cost.');
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
const money = (value) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
async function purchases(filter) {
  return db.withInventoryLock(async () => {
    const now = new Date(); const zone = time.timeZone();
    const records = await db.listReportPurchases({ ...filter, limit: MAX_ROWS + 1 });
    checkSize(records);
    const totals = new Map(); let missingCosts = 0;
    const rows = records.map((row) => {
      if (row.totalCost === null || row.totalCost === undefined) missingCosts++;
      else totals.set(row.currency, (totals.get(row.currency) || 0n) + cents(row.totalCost));
      return { id: row.id, date: row.receivedOn, item: row.itemSnapshot.name, group: row.itemSnapshot.category,
        location: row.itemSnapshot.location, quantity: decimal(amount(row.quantity)), unit: row.unit,
        supplier: row.supplier || 'Not recorded', currency: row.currency,
        totalCost: row.totalCost === null || row.totalCost === undefined ? 'Not recorded' : money(cents(row.totalCost)),
      };
    });
    return { ...base('purchases', { from: filter.from, to: filter.to, roomId: null, roomName: null }, now, zone),
      columns: purchaseColumns, rows,
      summary: [
        { label: 'Purchase records', value: String(rows.length) },
        ...(totals.size ? [...totals].sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, value]) => ({ label: 'Recorded cost (' + currency + ')', value: money(value) })) :
          [{ label: 'Recorded cost', value: 'Not recorded' }]),
        { label: 'Records without a cost', value: String(missingCosts) },
      ],
      notes: ['Dates are the recorded received dates. Item, group, location and unit show the details saved with each purchase.',
        'Recorded cost adds only entered costs, separately for each currency. Missing costs are not treated as zero.'],
    };
  });
}
exports.read = (kind, query) => {
  if (!['attendance', 'purchases'].includes(kind)) throw problem('Unknown report.', 404);
  const filter = filters(kind, query);
  return kind === 'attendance' ? attendance(filter) : purchases(filter);
};
