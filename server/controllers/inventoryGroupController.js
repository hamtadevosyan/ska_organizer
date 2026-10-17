const service = require('../services/inventoryGroupService');
exports.context = async (req, res, next) => { try { res.json({ data: await service.context(req.params.id) }); } catch (error) { next(error); } };
exports.preview = async (req, res, next) => { try { res.json({ data: await service.preview(req.params.id, req.body, req.account) }); } catch (error) { next(error); } };
exports.commit = async (req, res, next) => { try { res.status(201).json({ data: await service.commit(req.params.id, req.body, req.account) }); } catch (error) { next(error); } };
exports.get = async (req, res, next) => { try { res.json({ data: await service.get(req.params.id) }); } catch (error) { next(error); } };
exports.byRequest = async (req, res, next) => { try { res.json({ data: await service.byRequest(req.params.requestId, req.account) }); } catch (error) { next(error); } };
