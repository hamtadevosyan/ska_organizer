// Check the configured local runtime without loading a model or changing data.
// Errors intentionally exclude paths, environment values and upstream bodies.
(async () => {
  try {
    const os = require('node:os');
    const gib = bytes => (bytes / (1024 ** 3)).toFixed(1);
    console.log('Host: ' + os.arch() + ', ' + os.cpus().length + ' logical CPUs');
    console.log('Memory: ' + gib(os.totalmem()) + ' GiB total, ' + gib(os.freemem()) + ' GiB free');
    require('../config/environment');
    const result = await require('../services/localActivityAi').status();
    const model = typeof result.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(result.model) ? result.model : null;
    console.log('Local activity AI: ' + (result.available ? 'ready' : result.enabled ? 'unavailable' : 'not configured'));
    if (model) console.log('Configured model: ' + model);
    if (Number.isInteger(result.sourceCount) && result.sourceCount >= 0) console.log('Reviewed reference excerpts: ' + result.sourceCount);
    // The service supplies fixed, sanitized operational messages only.
    if (typeof result.message === 'string') console.log(result.message);
    if (!result.available) {
      console.log('Configure an already installed local model in server/.env. Start Ollama with OLLAMA_NO_CLOUD=1 and OLLAMA_HOST=127.0.0.1:11434.');
      console.log('This check does not install software, download models, change services or use a cloud fallback.');
      process.exitCode = 1;
    }
  } catch {
    console.error('Local AI check could not complete. Review the SKAO_AI settings and installed application files. No settings were changed.');
    process.exitCode = 1;
  }
})();
