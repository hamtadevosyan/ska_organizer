export const INVENTORY_CHANGED = 'skao.inventory.changed';
export function announceInventoryChange() {
  // Only a notification is stored; inventory and account details stay out of storage.
  try { localStorage.setItem(INVENTORY_CHANGED, `${Date.now()}-${Math.random()}`); } catch { /* Cross-tab notification is optional. */ }
  window.dispatchEvent(new Event(INVENTORY_CHANGED));
}
