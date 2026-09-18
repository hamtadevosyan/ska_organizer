const { problem } = require('./planValidation');

// Exact rational factors: nanograms for mass, nanolitres for US volume.
// Count, box and pack have no implicit package-size conversion.
const factors = {
  g: ['mass', 1000000000n], oz: ['mass', 28349523125n], lb: ['mass', 453592370000n],
  ml: ['volume', 1000000000n], gal: ['volume', 3785411784000n],
};
const compatible = (from, to) => from === to || !!(factors[from] && factors[to] && factors[from][0] === factors[to][0]);
function convert(value, from, to) {
  if (from === to) return value;
  if (!compatible(from, to)) {
    throw problem('Linked inventory uses an incompatible unit. Correct the inventory link before recalculating.', 409);
  }
  // Round available stock down to a millionth, so a conversion never promises
  // more stock than recorded. Receipts always use the item's exact recorded unit.
  return value * factors[from][1] / factors[to][1];
}

module.exports = { compatible, convert };
