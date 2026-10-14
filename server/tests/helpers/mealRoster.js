const db = require('../../services/dbAdapter');

// Explicit fictional enrollment/employment setup, rather than production defaults.
// Reuse the adapter's transaction context so a larger roster does not perform
// a separate PostgreSQL BEGIN/COMMIT for every fictional enrollment or employee.
exports.addMealRoster = (childrenCount, staffCount) => db.withTransaction(async () => {
  const children = [];
  const staff = [];
  for (let index = 0; index < childrenCount; index++) {
    children.push(await db.createChild({ firstName: 'Synthetic', lastName: `Meal child ${index}`,
      dateOfBirth: '2022-01-15', active: true }));
  }
  for (let index = 0; index < staffCount; index++) {
    staff.push(await db.createStaff({ name: `Synthetic meal employee ${index}`, role: 'Teacher', active: true }));
  }
  return { children, staff };
});
