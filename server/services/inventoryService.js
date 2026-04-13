// server/services/inventoryService.js

function getInventoryItems() {
  return [
    { id: '1', name: 'Diapers', category: 'Supplies', quantity: 120 },
    { id: '2', name: 'Crayons', category: 'Art', quantity: 60 },
    { id: '3', name: 'Books', category: 'Education', quantity: 30 },
  ];
}

function getStatus() {
  return {
    lowStock: 5,
    outOfStock: 2,
    categories: [
      { name: 'Arts and Crafts', status: 'low' },
      { name: 'Supply Room', status: 'out' }
    ]
  };
}

module.exports = {
  getInventoryItems,
  getStatus,
};

