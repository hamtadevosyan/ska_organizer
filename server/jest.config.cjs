module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '\\.postgres\\.test\\.js$'],
  setupFilesAfterEnv: ['<rootDir>/tests/databaseSetup.js'],
};
