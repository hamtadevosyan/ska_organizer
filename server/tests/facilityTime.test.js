const time = require('../services/facilityTime');
const previousZone = process.env.FACILITY_TIME_ZONE;
beforeEach(() => { process.env.FACILITY_TIME_ZONE = 'America/Los_Angeles'; });
afterAll(() => { if (previousZone === undefined) delete process.env.FACILITY_TIME_ZONE; else process.env.FACILITY_TIME_ZONE = previousZone; });

test('facility date is independent of the machine zone and UTC midnight', () => {
  expect(time.dateAt('2026-09-08T06:59:59Z')).toBe('2026-09-07');
  expect(time.dateAt('2026-09-08T07:00:00Z')).toBe('2026-09-08');
});
test('spring and fall days use their actual 23-hour and 25-hour boundaries', () => {
  expect(time.dayBounds('2026-03-08')).toEqual({ from: '2026-03-08T08:00:00.000Z', to: '2026-03-09T07:00:00.000Z' });
  expect(time.dayBounds('2026-11-01')).toEqual({ from: '2026-11-01T07:00:00.000Z', to: '2026-11-02T08:00:00.000Z' });
});
test('corrections reject nonexistent times and require a deliberate repeated-time choice', () => {
  expect(() => time.resolveTime('2026-03-08T02:30')).toThrow('does not exist');
  expect(() => time.resolveTime('2026-11-01T01:30')).toThrow('occurs twice');
  expect(time.resolveTime('2026-11-01T01:30', 'earlier')).toBe('2026-11-01T08:30:00.000Z');
  expect(time.resolveTime('2026-11-01T01:30', 'later')).toBe('2026-11-01T09:30:00.000Z');
  expect(time.resolveTime('2026-11-01T01:30:00-08:00')).toBe('2026-11-01T09:30:00.000Z');
});
test('invalid calendar dates, times and zone configuration are rejected', () => {
  for (const date of ['2026-02-30', '2026-13-01', 'not-a-date', ['2026-09-07']]) expect(() => time.validateDate(date)).toThrow();
  for (const stamp of ['2026-02-30T10:00:00Z', '2026-09-07T25:00', '2026-09-07T24:00:00Z', null]) expect(() => time.resolveTime(stamp)).toThrow();
  process.env.FACILITY_TIME_ZONE = 'Unknown/Facility';
  expect(() => time.timeZone()).toThrow('FACILITY_TIME_ZONE');
});
