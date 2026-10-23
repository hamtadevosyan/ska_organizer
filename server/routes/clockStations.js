const express = require('express');
const config = require('../auth/config');
const auth = require('../auth/service');
const { requireSession, requireAdmin, readToken, clearCookie } = require('../auth/middleware');
const service = require('../services/clockStationService');
const payroll = require('../services/payrollService');
const cookieName = 'skao_clock_station';
const cookieOptions = { httpOnly: true, secure: config.cookieOptions.secure, sameSite: 'strict', path: '/api' };
function readCredential(req) {
  const values = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName + '='));
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : undefined;
}
const options = req => ({ ip: req.ip, csrfToken: req.get('X-CSRF-Token') });
const protect = action => async (req, res, next) => {
  try { await action(req, res); } catch (error) { if (error.code === 'STATION_EXPIRED') res.clearCookie(cookieName, cookieOptions); next(error); }
};
async function denyPersonalAtStation(req, res, next) {
  try {
    if (await service.hasActiveStation(readCredential(req))) throw auth.problem('This device is a clock station. Sign out of station mode before using a personal account.', 403, 'STATION_MODE');
    next();
  } catch (error) { next(error); }
}
const station = express.Router();
station.get('/session', protect(async (req, res) => res.json({ data: await service.session(readCredential(req)) })));
station.post('/pair', protect(async (req, res) => {
  const result = await service.pair(req.body || {}, { ip: req.ip, personalToken: readToken(req), previousCredential: readCredential(req) });
  clearCookie(res); res.cookie(cookieName, result.credential, { ...cookieOptions, maxAge: result.maxAge });
  res.json({ data: { station: result.station, csrfToken: result.csrfToken } });
}));
station.post('/identify', protect(async (req, res) => res.json({ data: await payroll.stationIdentify(readCredential(req), req.body || {}, options(req)) })));
station.post('/clock', protect(async (req, res) => res.json({ data: await payroll.stationClock(readCredential(req), req.body || {}, options(req)) })));
station.post('/logout', protect(async (req, res) => { const data = await service.logout(readCredential(req), { ...options(req), personalToken: readToken(req) }); clearCookie(res); res.clearCookie(cookieName, cookieOptions); res.json({ data }); }));
const management = express.Router(); management.use(requireSession, requireAdmin);
management.get('/', async (req, res) => res.json({ data: await service.management(req.sessionToken) }));
management.post('/pairing', async (req, res) => res.json({ data: await service.createPairing(req.sessionToken, req.body || {}) }));
management.post('/:id/revoke', async (req, res) => res.json({ data: await service.revoke(req.sessionToken, req.params.id, req.body || {}) }));
management.post('/staff/:id/pin', async (req, res) => res.json({ data: await service.setPin(req.sessionToken, req.params.id, req.body || {}) }));
module.exports = { station, management, readCredential, denyPersonalAtStation };
