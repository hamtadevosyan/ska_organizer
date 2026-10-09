export const STAFF_COMPLIANCE_CHANGED = 'skao:staff-compliance-changed';

// A local invalidation signal only. Listeners fetch the authorized reminder
// response instead of receiving personnel information in an event payload.
export function notifyStaffComplianceChanged(signal?: AbortSignal) {
  if (!signal?.aborted) window.dispatchEvent(new Event(STAFF_COMPLIANCE_CHANGED));
}
