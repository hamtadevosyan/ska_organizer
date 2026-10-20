const db = require('./dbAdapter');
const auth = require('../auth/service');
const textFields = {
  allergies: 2000, dietaryRestrictions: 2000, medicalAlerts: 2000,
  careInstructions: 4000, medicationInstructions: 2000, medicationLocation: 500,
  physicianName: 150, physicianPhone: 80, pickupRestrictions: 2000,
};
const detailFields = ['allergyStatus', ...Object.keys(textFields), 'emergencyContacts', 'authorizedPickup', 'treatmentConsent'];
const empty = () => ({ allergyStatus: 'unknown', ...Object.fromEntries(Object.keys(textFields).map(key => [key, ''])),
  emergencyContacts: [], authorizedPickup: [], treatmentConsent: 'unknown' });
function contacts(value, name, requirePhone = true) {
  if (!Array.isArray(value) || value.length > 10) throw auth.problem(name + ' must contain at most ten people.');
  return value.map(person => {
    if (!person || typeof person !== 'object' || Array.isArray(person) || Object.keys(person).some(key => !['name', 'relationship', 'phone'].includes(key))) throw auth.problem('Supply a name, relationship and phone for each person.');
    const result = {};
    for (const [key, limit] of [['name', 150], ['relationship', 100], ['phone', 80]]) {
      if (typeof person[key] !== 'string' || person[key].trim().length > limit || (key === 'name' || key === 'phone' && requirePhone) && !person[key].trim()) throw auth.problem('Each contact needs a name and phone number, with an optional relationship.');
      result[key] = person[key].trim();
    }
    return result;
  });
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['version', 'reviewed', ...detailFields].includes(key))) throw auth.problem('Supply the safety card fields only.');
  if (!Number.isSafeInteger(input.version) || input.version < 0) throw auth.problem('Supply the safety card version.');
  if (input.reviewed !== true) throw auth.problem('Review the safety information against the current parent and medical instructions before saving.');
  const result = empty();
  if (!['unknown', 'none', 'recorded'].includes(input.allergyStatus)) throw auth.problem('Choose whether allergies are unknown, none reported or recorded.');
  if (!['unknown', 'on-file', 'not-on-file'].includes(input.treatmentConsent)) throw auth.problem('Choose the emergency treatment consent status.');
  result.allergyStatus = input.allergyStatus; result.treatmentConsent = input.treatmentConsent;
  for (const [key, limit] of Object.entries(textFields)) {
    if (typeof input[key] !== 'string' || input[key].trim().length > limit) throw auth.problem('Supply ' + key + ' as text up to ' + limit + ' characters.');
    result[key] = input[key].trim();
  }
  if (result.allergyStatus === 'recorded' && !result.allergies) throw auth.problem('Describe the reported allergies.');
  if (result.allergyStatus !== 'recorded' && result.allergies) throw auth.problem('Select recorded allergies when allergy details are entered.');
  result.emergencyContacts = contacts(input.emergencyContacts, 'Emergency contacts');
  result.authorizedPickup = contacts(input.authorizedPickup, 'Authorized pickup', false);
  return result;
}
// Explicit projection, even for legacy or malformed stored JSON. Never expose
// reviewer IDs, registration files, insurance or generic profile notes.
function projection(profile) {
  const details = empty();
  if (profile) {
    const saved = profile.details || {};
    for (const key of Object.keys(textFields)) {
      if (typeof saved[key] === 'string') details[key] = saved[key];
    }
    if (['unknown', 'none', 'recorded'].includes(saved.allergyStatus)) details.allergyStatus = saved.allergyStatus;
    if (['unknown', 'on-file', 'not-on-file'].includes(saved.treatmentConsent)) details.treatmentConsent = saved.treatmentConsent;
    if (details.allergyStatus === 'recorded' && !details.allergies) details.allergyStatus = 'unknown';
    for (const key of ['emergencyContacts', 'authorizedPickup']) details[key] = Array.isArray(saved[key])
      ? saved[key].map(row => ({ name: row.name, relationship: row.relationship, phone: row.phone })) : [];
  }
  return { version: profile?.version ?? 0, reviewedAt: profile?.reviewedAt ?? null, ...details };
}
async function requireChild(id) {
  const child = await db.getChildById(id);
  if (!child) throw auth.problem('Child not found.', 404);
  return child;
}
const locked = operation => db.withAuthLock(() => db.withRoomLock(operation));
exports.read = (token, childId) => locked(async () => {
  const account = await auth.sessionAccount(token, { touch: true });
  auth.operationalPermission(account, false);
  if (!['admin', 'editor'].includes(account.role)) throw auth.problem('Use the safety card in your assigned class.', 403, 'FORBIDDEN');
  await requireChild(childId);
  const card = projection(await db.getChildSafetyProfile(childId));
  await auth.audit(account, 'child.safety.view', childId);
  return card;
});
exports.save = (token, childId, input) => locked(async () => {
  const account = await auth.administrator(token);
  await requireChild(childId);
  const details = validate(input);
  const previous = await db.getChildSafetyProfile(childId);
  if (input.version !== (previous?.version ?? 0)) throw auth.problem('The safety card changed elsewhere. Reload it before saving.', 409, 'SAFETY_VERSION_CONFLICT');
  const profile = await db.saveChildSafetyProfile({ childId, details, version: input.version + 1,
    reviewedAt: new Date().toISOString(), reviewedBy: account.id });
  await auth.audit(account, 'child.safety.update', childId);
  return projection(profile);
});
exports.projection = projection;
