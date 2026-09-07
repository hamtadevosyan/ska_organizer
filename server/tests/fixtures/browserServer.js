// Isolated browser-test process. Never loads the development .env or database.
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'mock';
require('../../index').listen(3009, '127.0.0.1', () => console.log('Browser fixture server ready'));
