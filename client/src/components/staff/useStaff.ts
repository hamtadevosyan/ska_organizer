import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { listStaff } from '../../api/staff';
import type { StaffDirectory, StaffFilters } from '../../api/staff';
import { authError } from '../../auth/transport';

export function useStaff(filters: StaffFilters) {
  const [data, setData] = useState<StaffDirectory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const { q, active, roomId, page } = filters;
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setLoading(true); setError('');
    try {
      const result = await listStaff({ q, active, roomId, page }, request.signal);
      if (!request.signal.aborted) setData(result);
    } catch (failure) {
      if (!request.signal.aborted && !axios.isCancel(failure)) {
        setData(null);
        setError(authError(failure, 'Could not load staff. Use Refresh staff to try again.'));
      }
    } finally { if (!request.signal.aborted) setLoading(false); }
  }, [q, active, roomId, page]);
  useEffect(() => { void refresh(); return () => pending.current?.abort(); }, [refresh]);
  return { data, loading, error, refresh };
}
