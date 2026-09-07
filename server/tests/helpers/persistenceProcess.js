const { fork } = require('node:child_process');
const path = require('node:path');

function runPersistenceProcess(phase, databaseUrl, schema) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, '../fixtures/mealPersistenceProcess.js'), [phase], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, NODE_ENV: 'test', DB_ADAPTER: 'sequelize', DATABASE_URL: databaseUrl, DB_SCHEMA: schema },
    });
    let message;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('message', (value) => { message = value; });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0 && message?.snapshot) resolve(message.snapshot);
      else reject(new Error(message?.error || 'Persistence process failed or timed out.'));
    });
  });
}

module.exports = { runPersistenceProcess };
