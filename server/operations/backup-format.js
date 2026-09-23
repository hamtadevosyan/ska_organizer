const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const required = ['Meals', 'Ingredients', 'MealIngredients', 'WeeklyPlans', 'Accounts', 'Rooms', 'Children',
  'Attendances', 'StaffMembers', 'InventoryGroups', 'InventoryItems', 'InventoryMovements', 'PurchaseReceipts',
  'Activities', 'ScheduleEntries', 'ScheduleWeeks', 'AuditEvents', 'SequelizeMeta'];
const coverage = {
  meals: ['Meals', 'Ingredients', 'MealIngredients'], plans: ['WeeklyPlans'], accounts: ['Accounts'],
  children: ['Children'], attendance: ['Attendances'], inventory: ['InventoryItems', 'InventoryMovements'],
  purchases: ['PurchaseReceipts'], activities: ['Activities', 'ScheduleEntries', 'ScheduleWeeks'], audits: ['AuditEvents'],
};
const safeName = (name) => typeof name === 'string' && /^backup-[0-9TZ-]+-[a-f0-9]{12}$/.test(name);
function validateManifest(value) {
  if (value?.format !== 1 || !safeName(value.name) || !/^[a-f0-9]{40}$/.test(value.release || '') ||
      !/^[a-f0-9]{64}$/.test(value.sha256 || '') || value.postgresMajor !== 17 || !Array.isArray(value.tables)) {
    throw new Error('Unsupported or incomplete backup manifest.');
  }
  const names = new Set();
  for (const table of value.tables) {
    if (typeof table.name !== 'string' || names.has(table.name) || !Number.isSafeInteger(table.count) || table.count < 0 ||
        !/^[a-f0-9]{64}$/.test(table.sha256 || '') || !Array.isArray(table.columns)) throw new Error('Invalid table fingerprint.');
    names.add(table.name);
  }
  if (required.some((name) => !names.has(name))) throw new Error('Backup is missing required organizer tables.');
  return value;
}
function compareTables(expected, actual) {
  const sorted = (tables) => [...tables].sort((a, b) => a.name.localeCompare(b.name));
  if (!isDeepStrictEqual(sorted(expected), sorted(actual))) throw new Error('Restored table definitions, counts or contents do not match the backup snapshot.');
}
function coverageResult(tables) {
  const counts = new Map(tables.map((table) => [table.name, table.count]));
  return Object.fromEntries(Object.entries(coverage).map(([name, entities]) => [name, entities.every((entity) => (counts.get(entity) || 0) > 0)]));
}
function rowDigest() {
  const digest = createHash('sha256'); let count = 0;
  return {
    add(value) { digest.update(String(Buffer.byteLength(value)) + ':'); digest.update(value); count++; },
    finish() { return { count, sha256: digest.digest('hex') }; },
  };
}
module.exports = { required, safeName, validateManifest, compareTables, coverageResult, rowDigest };
