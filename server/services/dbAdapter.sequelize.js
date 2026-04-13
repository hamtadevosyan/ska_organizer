// server/services/dbAdapter.sequelize.js
// Minimal Sequelize adapter skeleton. Call setup(connectionString) before using.
const { Sequelize, DataTypes, Op } = require('sequelize');

let sequelize;
let Child;
let Attendance;

exports.setup = async (connectionString = 'sqlite::memory:') => {
  sequelize = new Sequelize(connectionString, { logging: false });

  Child = sequelize.define('Child', {
    id: { type: DataTypes.STRING, primaryKey: true },
    firstName: DataTypes.STRING,
    lastName: DataTypes.STRING,
    dateOfBirth: DataTypes.DATEONLY,
    preferredName: DataTypes.STRING,
    photoConsent: DataTypes.BOOLEAN,
    notes: DataTypes.TEXT
  }, { timestamps: true });

  Attendance = sequelize.define('Attendance', {
    id: { type: DataTypes.STRING, primaryKey: true },
    childId: { type: DataTypes.STRING, allowNull: false },
    roomId: DataTypes.STRING,
    checkIn: DataTypes.DATE,
    checkOut: DataTypes.DATE,
    recordedBy: DataTypes.STRING
  }, { timestamps: false });

  Child.hasMany(Attendance, { foreignKey: 'childId' });

  await sequelize.sync();
  return { sequelize, Child, Attendance };
};

// Children
exports.listChildren = async (opts = {}) => {
  const where = {};
  if (opts.q) {
    where[Op.or] = [
      { firstName: { [Op.iLike]: `%${opts.q}%` } },
      { lastName: { [Op.iLike]: `%${opts.q}%` } }
    ];
  }
  return Child.findAll({ where, limit: opts.pageSize || 50, offset: ((opts.page || 1) - 1) * (opts.pageSize || 50) });
};

exports.getChildById = async (id) => Child.findByPk(id);
exports.createChild = async (payload) => Child.create(payload);
exports.updateChild = async (id, changes) => {
  const c = await Child.findByPk(id);
  if (!c) return null;
  return c.update(changes);
};
exports.deleteChild = async (id) => {
  const c = await Child.findByPk(id);
  if (!c) return false;
  await c.destroy();
  return true;
};

// Attendance
exports.listAttendance = async (filters = {}) => {
  const where = {};
  if (filters.roomId) where.roomId = filters.roomId;
  if (filters.childId) where.childId = filters.childId;
  if (filters.date) {
    where.checkIn = {
      [Op.between]: [new Date(`${filters.date}T00:00:00Z`), new Date(`${filters.date}T23:59:59Z`)]
    };
  }
  return Attendance.findAll({ where });
};

exports.getAttendanceById = async (id) => Attendance.findByPk(id);
exports.createAttendance = async (payload) => Attendance.create(payload);
exports.updateAttendance = async (id, changes) => {
  const a = await Attendance.findByPk(id);
  if (!a) return null;
  return a.update(changes);
};

