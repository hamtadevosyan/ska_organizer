import { useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../../lib/api';
import { authError, onSessionExpired } from '../../auth/transport';
export function EnrollmentProgress({ childId }: { childId: string }) {
  const [result, setResult] = useState<{ complete: boolean; percentage: number } | null>(null);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  useEffect(() => onSessionExpired(() => { setResult(null); setError(''); setExpired(true); }), []);
  useEffect(() => {
    setResult(null); setError('');
    if (expired) return;
    const controller = new AbortController();
    void axios.get<{ complete: boolean; percentage: number }>(`${API_BASE_URL}/api/children/${encodeURIComponent(childId)}/enrollment-progress`, { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setResult(response.data); })
      .catch(failure => { if (!controller.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Enrollment completion could not be checked.')); });
    return () => controller.abort();
  }, [childId, expired]);
  if (expired) return null;
  return <div className="rounded-xl bg-blue-50 p-3 text-sm">
    {error ? <p role="alert">{error}</p> : result ? <p role="status">Enrollment {result.percentage}% · {result.complete ? 'Complete' : 'Incomplete. An administrator needs to finish the required enrollment items.'}</p> : <p role="status">Checking enrollment completion…</p>}
  </div>;
}
