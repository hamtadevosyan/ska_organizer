// Check the configured local runtime without loading a model or changing data.
// Errors intentionally exclude paths, environment values and upstream bodies.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const aiKeys = ['SKAO_AI_MODEL', 'SKAO_AI_URL', 'SKAO_AI_TIMEOUT_MS', 'SKAO_AI_SOURCES_FILE', 'SKAO_AI_LAN', 'SKAO_AI_TOKEN', 'SKAO_AI_CA_FILE'];
const safeCodes = new Set(['AI_NOT_CONFIGURED', 'AI_UNAVAILABLE', 'AI_LOCAL_ONLY_REQUIRED', 'AI_CONFIGURATION_INVALID', 'AI_SOURCES_INVALID', 'AI_TIMEOUT', 'AI_INVALID_RESPONSE']);
(async () => {
  let stage = 'read AI configuration';
  try {
    const os = require('node:os');
    const gib = bytes => (bytes / (1024 ** 3)).toFixed(1);
    console.log('Host: ' + os.arch() + ', ' + os.cpus().length + ' logical CPUs');
    console.log('Memory: ' + gib(os.totalmem()) + ' GiB total, ' + gib(os.freemem()) + ' GiB free');
    // The checkout may have no node_modules. Do not load application environment
    // hooks, database secrets or Sequelize just to inspect runtime metadata.
    if (process.env.NODE_ENV !== 'test') {
      let source;
      try { source = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (source !== undefined) {
        if (Buffer.byteLength(source, 'utf8') > 1024 * 1024) throw new Error();
        const values = parseEnv(source);
        for (const key of aiKeys) {
          if (process.env[key] === undefined && Object.hasOwn(values, key)) process.env[key] = values[key];
        }
      }
    }
    stage = 'verify authenticated AI metadata';
    const result = await require('../services/localAiStatus').status();
    const model = typeof result.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(result.model) ? result.model : null;
    console.log('Local activity AI: ' + (result.available ? 'ready' : result.enabled ? 'unavailable' : 'not configured'));
    if (model) console.log('Configured model: ' + model);
    if (Number.isInteger(result.sourceCount) && result.sourceCount >= 0) console.log('Reviewed reference excerpts: ' + result.sourceCount);
    // The service supplies fixed, sanitized operational messages only.
    if (typeof result.message === 'string') console.log(result.message);
    if (!result.available) {
      console.error('FAIL: ' + stage + ' [' + (safeCodes.has(result.code) ? result.code : 'AI_CHECK_FAILED') + ']');
      console.log('Configure an already installed local model in server/.env. Start Ollama with OLLAMA_NO_CLOUD=1 and OLLAMA_HOST=127.0.0.1:11434.');
      console.log('This check does not install software, download models, change services or use a cloud fallback.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('FAIL: ' + stage + ' [' + (safeCodes.has(error.code) ? error.code : 'AI_CHECK_FAILED') + ']. No settings were changed.');
    process.exitCode = 1;
  }
})();
