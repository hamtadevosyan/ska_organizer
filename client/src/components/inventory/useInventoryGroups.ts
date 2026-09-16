import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { inventoryUrl } from '../../api/inventory';
import type { InventoryGroup } from '../../api/inventory';
import { authError } from '../../auth/transport';

export function useInventoryGroups() {
  const [groups, setGroups] = useState<InventoryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const request = new AbortController(); pending.current = request;
    setLoading(true); setError('');
    try {
      const response = await axios.get<{ items: InventoryGroup[] }>(inventoryUrl + '/groups', { signal: request.signal });
      if (!request.signal.aborted) setGroups(response.data.items);
    } catch (failure) {
      if (!request.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load inventory groups. Use Refresh inventory to try again.'));
    } finally { if (!request.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); return () => pending.current?.abort(); }, [refresh]);
  const remember = (group: InventoryGroup) => setGroups((current) => [...current.filter((item) => item.id !== group.id), group].sort((a, b) => a.name.localeCompare(b.name)));
  return { groups, loading, error, refresh, remember };
}
