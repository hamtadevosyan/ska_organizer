process.env.FACILITY_TIME_ZONE = 'America/Los_Angeles';
const { randomUUID, createHash } = require('node:crypto');
const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const { reportCsv } = require('../services/reportCsv');
jest.setTimeout(30000);
const range = { from: '2026-03-08', to: '2026-03-08' };
const read = (kind = 'attendance', query = range) => request(app).get('/api/reports/' + kind).query(query);
const room = (values = {}) => db.createRoom({ name: 'Report room', capacity: 30, ageMinMonths: 0, ageMaxMonths: 72, ...values });
const child = (values = {}) => db.createChild({ firstName: 'Synthetic', lastName: 'Report', active: true, ...values });
const summary = (report) => Object.fromEntries(report.summary.map(({ label, value }) => [label, value]));
afterEach(() => jest.restoreAllMocks());

test('empty reports show truthful counts and unknown costs, and exports include filters and readable headers', async () => {
  const archived = await room({ name: 'Former room', active: false });
  const config = await request(app).get('/api/reports/config');
  expect(config.status).toBe(200);
  expect(config.body).toMatchObject({ timeZone: 'America/Los_Angeles', maxRangeDays: 366,
    rooms: [expect.objectContaining({ id: archived.id, active: false })] });
  for (const kind of ['attendance', 'purchases']) {
    const response = await read(kind);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.rows).toEqual([]);
    expect(response.body.filters).toMatchObject(range);
    expect(summary(response.body)).toMatchObject(kind === 'attendance' ?
      { 'Recorded visits': '0', 'Children with visits': '0' } :
      { 'Purchase records': '0', 'Recorded cost': 'Not recorded', 'Records without a cost': '0' });
    const csv = await read(kind + '.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(csv.headers['content-disposition']).toContain(kind + '-2026-03-08-to-2026-03-08.csv');
    expect(csv.headers['x-content-type-options']).toBe('nosniff');
    expect(csv.text).toContain('"From","2026-03-08"\r\n"To","2026-03-08"');
    expect(csv.text).toContain('"Facility time zone","America/Los_Angeles"');
    expect(csv.text).toContain(kind === 'attendance' ? '"Visit start date","Child","Room","Check-in","Check-out","Status"' :
      '"Received date","Item","Group","Location","Quantity","Unit","Supplier","Total cost","Currency"');
  }
});

test('attendance reconciles corrections, voids, carry-over visits and archived records across a 23-hour facility day', async () => {
  const target = await room(); const elsewhere = await room({ name: 'Other room' });
  const first = await child({ roomId: target.id }); const second = await child({ firstName: 'Corrected', roomId: target.id, notes: 'Private child notes' });
  const third = await child({ firstName: 'Voided', roomId: target.id }); const fourth = await child({ firstName: 'Open', roomId: target.id });
  const visit = (person, values) => db.createAttendance({ childId: person.id, roomId: target.id, ...values });
  const carry = await visit(first, { checkIn: '2026-03-08T07:30:00Z', checkOut: '2026-03-08T08:30:00Z' });
  const corrected = await visit(second, { checkIn: '2026-03-08T16:00:00Z', checkOut: '2026-03-08T17:00:00Z' });
  const edit = await request(app).put('/api/attendance/' + corrected.id + '/correction')
    .send({ version: 1, checkIn: '2026-03-08T08:30', reason: 'Verified arrival from the paper log.' });
  expect(edit.status).toBe(200);
  const voided = await visit(third, { checkIn: '2026-03-08T18:00:00Z', checkOut: '2026-03-08T19:00:00Z', voided: true });
  const open = await visit(fourth, { checkIn: '2026-03-07T18:00:00Z', checkOut: null });
  await visit(first, { checkIn: '2026-03-08T06:00:00Z', checkOut: '2026-03-08T08:00:00Z' }); // Ends exactly at the range start.
  await visit(first, { checkIn: '2026-03-09T07:00:00Z', checkOut: '2026-03-09T08:00:00Z' }); // Starts exactly at the range end.
  await visit(first, { checkIn: null, needsReview: true });
  await visit(first, { roomId: elsewhere.id, checkIn: null, needsReview: true });
  await visit(first, { roomId: elsewhere.id, checkIn: '2026-03-08T20:00:00Z', checkOut: '2026-03-08T21:00:00Z' });
  await db.updateRoom(target.id, { active: false });
  await db.updateChild(second.id, { active: false, roomId: elsewhere.id });
  const before = await db.listAttendance(); const auditBefore = await db.listAudit();
  const response = await read('attendance', { ...range, roomId: target.id });
  expect(response.status).toBe(200);
  expect(response.body.rows).toHaveLength(4);
  expect(response.body.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: carry.id, date: '2026-03-07', checkIn: '2026-03-07 23:30:00 GMT-8' }),
    expect.objectContaining({ id: corrected.id, child: 'Corrected Report', room: target.name, checkIn: '2026-03-08 08:30:00 GMT-7' }),
    expect.objectContaining({ id: voided.id, status: 'Voided' }),
    expect.objectContaining({ id: open.id, status: 'Needs review', checkOut: 'Not recorded' }),
  ]));
  expect(summary(response.body)).toEqual({ 'Recorded visits': '3', 'Children with visits': '3',
    'Visits without check-out': '1', 'Needs review': '1', 'Voided visits': '1' });
  expect(response.body.notes.join(' ')).toContain('1 non-voided attendance record(s) in this room have no check-in date');
  expect(JSON.stringify(response.body)).not.toContain('Private child notes');
  expect((await read('attendance.csv', { ...range, roomId: target.id })).text).toContain('"Room","Report room"');
  expect(await db.listAttendance()).toEqual(before);
  expect(await db.listAudit()).toEqual(auditBefore);
});

test('repeated daylight-saving times keep their offsets and unavailable names are explicit', async () => {
  const target = await room(); const person = await child();
  for (const hour of ['08', '09']) await db.createAttendance({ childId: person.id, roomId: target.id,
    checkIn: '2025-11-02T' + hour + ':30:00Z', checkOut: '2025-11-02T' + hour + ':45:00Z' });
  const dates = { from: '2025-11-02', to: '2025-11-02' };
  const response = await read('attendance', dates);
  expect(response.status).toBe(200);
  expect(response.body.rows.map((row) => row.checkIn)).toEqual(['2025-11-02 01:30:00 GMT-7', '2025-11-02 01:30:00 GMT-8']);
  jest.spyOn(db, 'listReportChildren').mockResolvedValueOnce([]);
  expect((await read('attendance', dates)).body.rows[0].child).toBe('Child record unavailable');
});

test('purchase reports use received dates, saved item details and exact recorded costs without changing stock', async () => {
  const created = await request(app).post('/api/inventory').send({ name: 'Report paper', category: 'Supplies', location: 'Shelf 1',
    unit: 'pack', openingQuantity: '0', reorderThreshold: '0', reason: 'Initial count', requestId: randomUUID() });
  expect(created.status).toBe(201); let item = created.body.data;
  const receipts = [];
  for (const [receivedOn, totalCost] of [['2026-03-07', '99'], ['2026-03-08', '0.10'], ['2026-03-08', '0.20'],
    ['2026-03-08', null], ['2026-03-08', '0'], ['2026-03-09', '99']]) {
    const saved = await request(app).post('/api/inventory/' + item.id + '/purchases').send({ receivedOn, totalCost,
      supplier: '=1+1', quantity: '0.1', unit: item.unit, version: item.version, requestId: randomUUID() });
    expect(saved.status).toBe(201); item = saved.body.data.item; receipts.push(saved.body.data.receipt);
  }
  const renamed = await request(app).put('/api/inventory/' + item.id).send({ name: 'New label', location: 'Shelf 2',
    version: item.version, reason: 'Moved stock', requestId: randomUUID() });
  expect(renamed.status).toBe(200);
  const stockBefore = await db.getInventoryById(item.id); const historyBefore = await db.countInventoryMovements(item.id);
  const auditBefore = await db.listAudit();
  const response = await read('purchases');
  expect(response.status).toBe(200);
  expect(response.body.rows).toHaveLength(4);
  expect(response.body.rows.map((row) => row.id).sort()).toEqual(receipts.slice(1, 5).map((row) => row.id).sort());
  for (const row of response.body.rows) expect(row).toMatchObject({ date: '2026-03-08', item: 'Report paper',
    group: 'Supplies', location: 'Shelf 1', quantity: '0.1', unit: 'pack', currency: 'USD' });
  expect(response.body.rows.map((row) => row.totalCost)).toEqual(expect.arrayContaining(['0.10', '0.20', 'Not recorded', '0.00']));
  expect(summary(response.body)).toEqual({ 'Purchase records': '4', 'Recorded cost (USD)': '0.30', 'Records without a cost': '1' });
  const csv = await read('purchases.csv');
  expect(csv.text).toContain('"Recorded cost (USD)","0.30"');
  expect(csv.text).toContain('"\'=1+1"');
  expect(csv.text).toContain('"Not recorded"');
  expect(await db.getInventoryById(item.id)).toEqual(stockBefore);
  expect(await db.countInventoryMovements(item.id)).toBe(historyBefore);
  expect(await db.listAudit()).toEqual(auditBefore);
});

test('CSV quotes delimiters and neutralizes formula-like names, whitespace and control prefixes in metadata too', () => {
  const report = { kind: 'attendance', title: 'Attendance report', filters: { ...range, roomName: '=1+1' },
    timeZone: 'America/Los_Angeles', generatedLabel: '2026-03-08 10:00:00 GMT-7', summary: [], notes: [],
    columns: [{ key: 'name', label: 'Child' }], rows: [
      { name: 'Smith, "A"\nB' }, { name: '+1' }, { name: '-1' }, { name: '@SUM(1)' },
      { name: '  =1' }, { name: '\ttext' }, { name: '\u200b=1' }, { name: '＝1+1' },
    ] };
  const csv = reportCsv(report);
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv).toContain('"Room","\'=1+1"');
  expect(csv).toContain('"Smith, ""A""\nB"');
  for (const value of report.rows.slice(1)) expect(csv).toContain('"\'' + value.name + '"');
  expect(csv.endsWith('\r\n')).toBe(true);
});

test('invalid dates, arrays, ranges and unsupported filters are rejected equally by JSON and CSV', async () => {
  for (const suffix of ['', '.csv']) {
    for (const query of [{}, { from: '2026-02-30', to: '2026-03-08' }, { from: '2026-03-09', to: '2026-03-08' },
      { from: '2024-01-01', to: '2025-01-01' }, { ...range, from: ['2026-03-08', '2026-03-09'] },
      { ...range, roomId: '' }, { ...range, roomId: 'missing' }, { ...range, unknown: 'true' },
      { from: '9999-12-31', to: '9999-12-31' }]) {
      expect((await read('attendance' + suffix, query)).status).toBe(400);
    }
    expect((await read('purchases' + suffix, { ...range, roomId: 'anything' })).status).toBe(400);
    expect((await read('attendance' + suffix, { from: '2024-01-01', to: '2024-12-31' })).status).toBe(200);
  }
  expect((await request(app).get('/api/reports/config?unknown=true')).status).toBe(400);
});

test('configuration, JSON and exports all require the same active operational session', async () => {
  const paths = ['config', 'attendance', 'attendance.csv', 'purchases', 'purchases.csv'];
  const get = (client, path) => client.get('/api/reports/' + path).query(path === 'config' ? {} : range);
  for (const path of paths) expect((await get(anonymous(app), path)).status).toBe(401);
  const id = request.credentials().account.id;
  for (const role of ['admin', 'editor', 'viewer']) {
    await db.updateAccount(id, { role });
    for (const path of paths) expect((await get(request(app), path)).status).toBe(200);
  }
  await db.updateAccount(id, { mustChangePassword: true });
  for (const path of paths) expect((await get(request(app), path)).status).toBe(403);
  await db.updateAccount(id, { mustChangePassword: false, disabled: true });
  for (const path of paths) expect((await get(request(app), path)).status).toBe(401);
  await db.updateAccount(id, { disabled: false });
  const sessionId = createHash('sha256').update(request.credentials().cookie.split('=')[1]).digest('hex');
  await db.updateSession(sessionId, { expiresAt: new Date('2000-01-01') });
  for (const path of paths) expect((await get(request(app), path)).status).toBe(401);
});

test('storage failures are redacted and excessive reports are rejected instead of silently truncated', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  for (const [kind, method] of [['attendance', 'listReportAttendance'], ['purchases', 'listReportPurchases']]) {
    for (const suffix of ['', '.csv']) {
      const failure = jest.spyOn(db, method).mockRejectedValueOnce(new Error('Private database details'));
      const response = await read(kind + suffix);
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: { message: 'Internal server error.' } });
      expect(response.text).not.toContain('Private'); failure.mockRestore();
      const tooMany = jest.spyOn(db, method).mockResolvedValueOnce(Array(50001).fill({}));
      const oversized = await read(kind + suffix);
      expect(oversized.status).toBe(400);
      expect(oversized.body.error.message).toContain('Choose a shorter date range'); tooMany.mockRestore();
    }
  }
});
