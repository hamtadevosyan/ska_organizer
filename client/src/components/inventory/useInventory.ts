import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { authError } from '../../auth/transport';
import { inventoryUrl } from '../../api/inventory';
import type { InventoryFilters, InventoryList } from '../../api/inventory';

export function useInventory({ q, category, location, status, page }: InventoryFilters) {
  const [data, setData] = useState<InventoryList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const request = new AbortController(); pending.current = request;
    setLoading(true); setError('');
    try {
      const response = await axios.get<InventoryList>(inventoryUrl, { params: { q: q || undefined,
        category: category || undefined, location: location || undefined, status, page, pageSize: 25 }, signal: request.signal });
      if (!request.signal.aborted) setData(response.data);
    } catch (failure) {
      if (!request.signal.aborted && !axios.isCancel(failure)) {
        setData(null); setError(authError(failure, 'Could not load inventory. Use Refresh inventory to try again.'));
      }
    } finally { if (!request.signal.aborted) setLoading(false); }
  }, [q, category, location, status, page]);
  useEffect(() => { void refresh(); return () => pending.current?.abort(); }, [refresh]);
  return { data, loading, error, refresh };
}
