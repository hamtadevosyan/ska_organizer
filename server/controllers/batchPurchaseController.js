const service = require('../services/batchPurchaseService');
exports.list = async (req, res, next) => { try { res.json(await service.list(req.query)); } catch (error) { next(error); } };
exports.get = async (req, res, next) => { try { res.json({ data: await service.get(req.params.id) }); } catch (error) { next(error); } };
exports.byRequest = async (req, res, next) => { try { res.json({ data: await service.byRequest(req.params.requestId, req.account) }); } catch (error) { next(error); } };
exports.fulfillment = async (req, res, next) => { try { res.json({ data: await service.fulfillment(req.params.weekStart) }); } catch (error) { next(error); } };
exports.preview = async (req, res, next) => { try { res.json({ data: await service.preview(req.body) }); } catch (error) { next(error); } };
exports.receive = async (req, res, next) => { try { res.status(201).json({ data: await service.receive(req.body, req.account) }); } catch (error) { next(error); } };
