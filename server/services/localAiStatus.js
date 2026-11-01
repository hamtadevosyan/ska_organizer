// Read-only runtime metadata; intentionally independent of application/database packages.
const knowledge = require('./localActivityKnowledge');
const { configuration, verifyRuntime, limited } = require('./localAiRuntime');

async function status(options = {}) {
  let config;
  try {
    const { sourceCount } = await knowledge.status();
    config = configuration();
    if (!config) return { enabled: false, available: false, model: null, sourceCount,
      code: 'AI_NOT_CONFIGURED', message: 'Local AI is not set up yet. You can keep using saved activities.' };
    const model = await limited(config, options, signal => verifyRuntime(config, signal), Math.min(config.timeout, 10000));
    return { enabled: true, available: true, model, sourceCount, message: 'Local AI is ready. Review each idea before saving.' };
  } catch (error) {
    if (!error.code?.startsWith('AI_')) throw error;
    return { enabled: !!process.env.SKAO_AI_MODEL, available: false, model: config?.model || null, sourceCount: 0, code: error.code, message: error.message };
  }
}

module.exports = { status };
