const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const id = () => ({ type: DataTypes.STRING, primaryKey: true, defaultValue: DataTypes.UUIDV4 });
  const Meal = sequelize.define('Meal', {
    id: id(), name: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    archived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  });
  const Ingredient = sequelize.define('Ingredient', {
    id: id(), name: { type: DataTypes.STRING, allowNull: false },
    unit: { type: DataTypes.STRING, allowNull: false },
    shelfLifeDays: { type: DataTypes.INTEGER, validate: { min: 0 } },
    archived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  });
  const MealIngredient = sequelize.define('MealIngredient', {
    id: id(), mealId: { type: DataTypes.STRING, allowNull: false },
    ingredientId: { type: DataTypes.STRING, allowNull: false },
    quantity: {
      type: DataTypes.DECIMAL(18, 6), allowNull: false,
      validate: { min: 0, isDecimal: true },
      get() { return Number(this.getDataValue('quantity')); },
    },
  });
  const ConfirmedMenu = sequelize.define('ConfirmedMenu', {
    id: { type: DataTypes.STRING, primaryKey: true },
    week: { type: DataTypes.JSONB, allowNull: false },
    confirmedAt: { type: DataTypes.DATE, allowNull: false },
  }, { timestamps: false });
  const WeeklyPlan = sequelize.define('WeeklyPlan', {
    weekStart: { type: DataTypes.DATEONLY, primaryKey: true },
    version: { type: DataTypes.INTEGER, allowNull: false },
    snapshot: { type: DataTypes.JSONB, allowNull: false },
    savedAt: { type: DataTypes.DATE, allowNull: false },
  }, { timestamps: false });
  // One atomic snapshot matches the existing shelf-check API.
  const ShelfCheck = sequelize.define('ShelfCheck', {
    id: { type: DataTypes.STRING, primaryKey: true },
    items: { type: DataTypes.JSONB, allowNull: false },
  }, { timestamps: false });
  // Preserve the earlier adapter contracts; later stories complete these modules.
  const Room = sequelize.define('Room', {
    id: id(), name: { type: DataTypes.STRING(100), allowNull: false },
    ageMinMonths: DataTypes.INTEGER, ageMaxMonths: DataTypes.INTEGER, capacity: DataTypes.INTEGER,
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  });
  const StaffMember = sequelize.define('StaffMember', {
    id: id(), name: { type: DataTypes.STRING(100), allowNull: false },
    role: { type: DataTypes.STRING(100), allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    roomId: { type: DataTypes.STRING, allowNull: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  }, { tableName: 'StaffMembers' });
  const InventoryGroup = sequelize.define('InventoryGroup', {
    id: id(), name: { type: DataTypes.STRING(80), allowNull: false },
    nameKey: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'supplies' },
    description: { type: DataTypes.STRING(240), allowNull: false, defaultValue: '' },
    requestId: { type: DataTypes.STRING(100), unique: true }, request: DataTypes.JSONB,
  });
  const InventoryItem = sequelize.define('InventoryItem', {
    id: id(), name: { type: DataTypes.STRING(100), allowNull: false },
    category: { type: DataTypes.STRING(80), allowNull: false }, location: { type: DataTypes.STRING(200), allowNull: false },
    groupId: { type: DataTypes.STRING, allowNull: false },
    unit: { type: DataTypes.STRING(16), allowNull: false }, ingredientId: DataTypes.STRING,
    quantity: { type: DataTypes.DECIMAL(18, 6), allowNull: false, defaultValue: '0' },
    reorderThreshold: { type: DataTypes.DECIMAL(18, 6), allowNull: false, defaultValue: '0' },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  });
  const InventoryMovement = sequelize.define('InventoryMovement', {
    id: id(), itemId: { type: DataTypes.STRING, allowNull: false }, type: DataTypes.STRING(16),
    delta: DataTypes.DECIMAL(18, 6), beforeQuantity: DataTypes.DECIMAL(18, 6), afterQuantity: DataTypes.DECIMAL(18, 6),
    reason: DataTypes.STRING(500), actorId: DataTypes.STRING, actorUsername: DataTypes.STRING(64),
    occurredAt: DataTypes.DATE, itemVersion: DataTypes.INTEGER, before: DataTypes.JSONB, after: DataTypes.JSONB,
    requestId: { type: DataTypes.STRING(100), unique: true }, request: DataTypes.JSONB,
  }, { timestamps: false });
  const PurchaseReceipt = sequelize.define('PurchaseReceipt', {
    id: id(), itemId: { type: DataTypes.STRING, allowNull: false },
    movementId: { type: DataTypes.STRING, allowNull: false, unique: true },
    quantity: { type: DataTypes.DECIMAL(18, 6), allowNull: false }, unit: DataTypes.STRING(16),
    receivedOn: { type: DataTypes.DATEONLY, allowNull: false }, supplier: DataTypes.STRING(200),
    totalCost: DataTypes.DECIMAL(14, 2), currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'USD' },
    itemSnapshot: { type: DataTypes.JSONB, allowNull: false },
    actorId: DataTypes.STRING, actorUsername: DataTypes.STRING(64), recordedAt: DataTypes.DATE,
  }, { timestamps: false });
  const Child = sequelize.define('Child', {
    id: id(), firstName: DataTypes.STRING, lastName: DataTypes.STRING,
    dateOfBirth: DataTypes.DATEONLY, preferredName: DataTypes.STRING,
    photoConsent: DataTypes.BOOLEAN, notes: DataTypes.TEXT, roomId: DataTypes.STRING,
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  });
  const ChildDocument = sequelize.define('ChildDocument', {
    id: id(), childId: { type: DataTypes.STRING, allowNull: false },
    title: { type: DataTypes.STRING(160), allowNull: false },
    category: { type: DataTypes.STRING(16), allowNull: false },
    documentDate: { type: DataTypes.DATEONLY, allowNull: true },
    notes: { type: DataTypes.STRING(2000), allowNull: false, defaultValue: '' },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    currentRevisionId: { type: DataTypes.STRING, allowNull: false },
    registrationFormId: { type: DataTypes.STRING, allowNull: true },
    registrationFormRevisionId: { type: DataTypes.STRING, allowNull: true },
    reviewedRevisionId: { type: DataTypes.STRING, allowNull: true },
    reviewedBy: { type: DataTypes.STRING, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
  });
  // Revisions are immutable. Content is part of the PostgreSQL transaction and
  // normal database backup, never a public static file or external storage URL.
  const ChildDocumentRevision = sequelize.define('ChildDocumentRevision', {
    id: id(), documentId: { type: DataTypes.STRING, allowNull: false },
    revision: { type: DataTypes.INTEGER, allowNull: false },
    filename: { type: DataTypes.STRING(200), allowNull: false },
    contentType: { type: DataTypes.STRING(32), allowNull: false },
    byteLength: { type: DataTypes.INTEGER, allowNull: false },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    content: { type: DataTypes.BLOB, allowNull: false },
    uploadedAt: { type: DataTypes.DATE, allowNull: false },
    actorId: { type: DataTypes.STRING, allowNull: false },
    uploadedBy: { type: DataTypes.STRING(64), allowNull: false },
    changeNote: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    requestId: { type: DataTypes.STRING(36), allowNull: false },
    requestScope: { type: DataTypes.STRING(64), allowNull: false },
    requestHash: { type: DataTypes.STRING(64), allowNull: false },
  }, { timestamps: false });
  const staffDocumentMetadata = () => ({
    title: { type: DataTypes.STRING(160), allowNull: false },
    category: { type: DataTypes.STRING(16), allowNull: false },
    documentDate: { type: DataTypes.DATEONLY, allowNull: true },
    notes: { type: DataTypes.STRING(2000), allowNull: false, defaultValue: '' },
    issuer: { type: DataTypes.STRING(200), allowNull: false, defaultValue: '' },
    reference: { type: DataTypes.STRING(100), allowNull: false, defaultValue: '' },
    issuedOn: { type: DataTypes.DATEONLY, allowNull: true },
    expiresOn: { type: DataTypes.DATEONLY, allowNull: true },
    nonExpiring: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    warningDays: { type: DataTypes.INTEGER, allowNull: true },
    registrationFormId: { type: DataTypes.STRING, allowNull: true },
    registrationFormRevisionId: { type: DataTypes.STRING, allowNull: true },
  });
  const StaffDocument = sequelize.define('StaffDocument', {
    id: id(), staffId: { type: DataTypes.STRING, allowNull: false },
    ...staffDocumentMetadata(),
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    currentRevisionId: { type: DataTypes.STRING, allowNull: false },
    reviewedRevisionId: { type: DataTypes.STRING, allowNull: true },
    reviewedBy: { type: DataTypes.STRING, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
  });
  // Every revision retains its exact original bytes and the submitted dates and
  // template mapping, including corrections made without uploading a new file.
  const StaffDocumentRevision = sequelize.define('StaffDocumentRevision', {
    id: id(), documentId: { type: DataTypes.STRING, allowNull: false },
    revision: { type: DataTypes.INTEGER, allowNull: false }, ...staffDocumentMetadata(),
    filename: { type: DataTypes.STRING(200), allowNull: false },
    contentType: { type: DataTypes.STRING(32), allowNull: false },
    byteLength: { type: DataTypes.INTEGER, allowNull: false },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    content: { type: DataTypes.BLOB, allowNull: false },
    uploadedAt: { type: DataTypes.DATE, allowNull: false },
    actorId: { type: DataTypes.STRING, allowNull: false },
    uploadedBy: { type: DataTypes.STRING(64), allowNull: false },
    changeNote: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    requestId: { type: DataTypes.STRING(36), allowNull: false },
    requestScope: { type: DataTypes.STRING(64), allowNull: false },
    requestHash: { type: DataTypes.STRING(64), allowNull: false },
  }, { timestamps: false });
  const StaffDocumentSettings = sequelize.define('StaffDocumentSettings', {
    id: { type: DataTypes.STRING, primaryKey: true },
    warningDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 40 },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  }, { tableName: 'StaffDocumentSettings' });
  const RegistrationForm = sequelize.define('RegistrationForm', {
    audience: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'child' },
    id: id(), title: { type: DataTypes.STRING(160), allowNull: false },
    instructions: { type: DataTypes.STRING(2000), allowNull: false, defaultValue: '' },
    category: { type: DataTypes.STRING(16), allowNull: false },
    required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    expirationRequired: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    currentRevisionId: { type: DataTypes.STRING, allowNull: true },
  });
  const RegistrationFormRevision = sequelize.define('RegistrationFormRevision', {
    id: id(), formId: { type: DataTypes.STRING, allowNull: false },
    revision: { type: DataTypes.INTEGER, allowNull: false },
    filename: { type: DataTypes.STRING(200), allowNull: false },
    contentType: { type: DataTypes.STRING(32), allowNull: false },
    byteLength: { type: DataTypes.INTEGER, allowNull: false },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    content: { type: DataTypes.BLOB, allowNull: false },
    uploadedAt: { type: DataTypes.DATE, allowNull: false },
    actorId: { type: DataTypes.STRING, allowNull: false },
    uploadedBy: { type: DataTypes.STRING(64), allowNull: false },
    changeNote: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    requestId: { type: DataTypes.STRING(36), allowNull: false },
    requestScope: { type: DataTypes.STRING(64), allowNull: false },
    requestHash: { type: DataTypes.STRING(64), allowNull: false },
  }, { timestamps: false });
  const Attendance = sequelize.define('Attendance', {
    id: id(), childId: { type: DataTypes.STRING, allowNull: false },
    roomId: DataTypes.STRING, checkIn: DataTypes.DATE,
    checkOut: DataTypes.DATE, recordedBy: DataTypes.STRING,
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    voided: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    needsReview: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    requestId: DataTypes.STRING(100),
  }, { timestamps: false });
  const AttendanceCorrection = sequelize.define('AttendanceCorrection', {
    id: id(), attendanceId: { type: DataTypes.STRING, allowNull: false },
    before: { type: DataTypes.JSONB, allowNull: false }, after: { type: DataTypes.JSONB, allowNull: false },
    reason: { type: DataTypes.STRING(1000), allowNull: false }, actorId: { type: DataTypes.STRING, allowNull: false },
    actorUsername: { type: DataTypes.STRING(64), allowNull: false }, occurredAt: { type: DataTypes.DATE, allowNull: false },
  }, { timestamps: false });
  const Activity = require('../models/activity')(sequelize, DataTypes);
  const ScheduleEntry = require('../models/scheduleEntry')(sequelize, DataTypes);
  const ScheduleWeek = sequelize.define('ScheduleWeek', {
    roomId: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    weekStart: { type: DataTypes.DATEONLY, primaryKey: true, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    savedAt: { type: DataTypes.DATE, allowNull: false },
    requestId: DataTypes.STRING(100), request: DataTypes.JSONB,
  }, { timestamps: false });
  const Account = sequelize.define('Account', {
    id: id(), username: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    displayName: { type: DataTypes.STRING(100), allowNull: false },
    passwordHash: { type: DataTypes.TEXT, allowNull: false },
    role: { type: DataTypes.STRING(16), allowNull: false },
    documentAccess: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'none' },
    disabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    mustChangePassword: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  });
  const Session = sequelize.define('Session', {
    id: id(), accountId: { type: DataTypes.STRING, allowNull: false },
    createdAt: DataTypes.DATE, lastSeenAt: DataTypes.DATE, expiresAt: DataTypes.DATE,
    remembered: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, { timestamps: false });
  const LoginAttempt = sequelize.define('LoginAttempt', {
    id: id(), count: DataTypes.INTEGER, expiresAt: DataTypes.DATE,
  }, { timestamps: false });
  const AuditEvent = sequelize.define('AuditEvent', {
    id: id(), actorId: DataTypes.STRING, actorUsername: DataTypes.STRING(64),
    action: DataTypes.STRING(80), entityId: DataTypes.STRING, occurredAt: DataTypes.DATE,
  }, { timestamps: false });
  return { Meal, Ingredient, MealIngredient, ConfirmedMenu, WeeklyPlan, ShelfCheck, Child, Attendance, Activity,
    Account, Session, LoginAttempt, AuditEvent, Room, ScheduleEntry, ScheduleWeek, AttendanceCorrection, StaffMember, InventoryGroup, InventoryItem, InventoryMovement, PurchaseReceipt,
    ChildDocument, ChildDocumentRevision, StaffDocument, StaffDocumentRevision, StaffDocumentSettings, RegistrationForm, RegistrationFormRevision };
};
