import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { authError } from '../../auth/transport';
import { roomsUrl } from '../../api/rooms';
import type { Room } from '../../api/rooms';

export function useRooms(includeArchived = true) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setLoading(true); setError('');
    try {
      const response = await axios.get<{ data: Room[] }>(roomsUrl, { params: { includeArchived }, signal: request.signal });
      if (!request.signal.aborted) setRooms(response.data.data);
    } catch (failure) {
      if (!request.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load rooms. Use Refresh to try again.'));
    } finally { if (!request.signal.aborted) setLoading(false); }
  }, [includeArchived]);
  useEffect(() => { void refresh(); return () => pending.current?.abort(); }, [refresh]);
  return { rooms, loading, error, refresh };
}
