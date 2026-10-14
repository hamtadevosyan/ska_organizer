const db = require('./dbAdapter');
const { problem, validateCounts } = require('./planValidation');

// Operational totals only: enrollment records and employee directory records,
// regardless of room assignment. Account logins and attendance are not rosters.
exports.getCounts = async () => {
  const [childrenCount, staffCount] = await Promise.all([
    db.countChildren({ active: true }),
    db.countStaff({ active: true }),
  ]);
  return { childrenCount, staffCount };
};

exports.resolveCounts = async ({ childrenCount, staffCount } = {}) => {
  const omitted = childrenCount === undefined || staffCount === undefined;
  if (omitted) {
    const roster = await exports.getCounts();
    if (childrenCount === undefined) childrenCount = roster.childrenCount;
    if (staffCount === undefined) staffCount = roster.staffCount;
  }
  if (omitted && childrenCount === 0 && staffCount === 0) {
    throw problem('There are no people to plan meals for. Add active children or staff, or enter a positive meal planning count.');
  }
  validateCounts(childrenCount, staffCount);
  return { childrenCount, staffCount };
};
