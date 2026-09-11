const { DataTypes, QueryTypes } = require('sequelize');
const migrations = [
  { name: '001-persistent-meals', ...require('./migrations/001-persistent-meals') },
  { name: '002-weekly-plans', ...require('./migrations/002-weekly-plans') },
  { name: '003-catalog-corrections', ...require('./migrations/003-catalog-corrections') },
  { name: '004-accounts-and-sessions', ...require('./migrations/004-accounts-and-sessions') },
  { name: '005-rooms-and-classes', ...require('./migrations/005-rooms-and-classes') },
];

const appliedMigrations = (sequelize, schema, transaction) =>
  sequelize.query(`SELECT "name" FROM "${schema}"."SequelizeMeta" ORDER BY "name"`, {
    type: QueryTypes.SELECT, transaction,
  });

async function migrate(sequelize, schema = 'public') {
  return sequelize.transaction(async (transaction) => {
    // Prevent concurrent migrations of the same schema. Released on commit/rollback.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:schema), 17001)', {
      replacements: { schema }, transaction,
    });
    await sequelize.getQueryInterface().createTable({ tableName: 'SequelizeMeta', schema }, {
      name: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    }, { transaction });
    const applied = new Set((await appliedMigrations(sequelize, schema, transaction)).map((r) => r.name));
    const completed = [];
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      await migration.up({ sequelize, schema, transaction, DataTypes });
      await sequelize.getQueryInterface().bulkInsert({ tableName: 'SequelizeMeta', schema }, [{ name: migration.name }], { transaction });
      completed.push(migration.name);
    }
    return completed;
  });
}

async function assertMigrated(sequelize, schema = 'public') {
  let applied;
  try { applied = await appliedMigrations(sequelize, schema); }
  catch (error) {
    if (error.original?.code !== '42P01') throw error;
    throw new Error('Database migrations are missing. Run npm run db:migrate from server.');
  }
  const names = new Set(applied.map((r) => r.name));
  if (migrations.some((m) => !names.has(m.name))) {
    throw new Error('Database migrations are pending. Run npm run db:migrate from server.');
  }
}

module.exports = { migrate, assertMigrated };
