// src/pages/Dashboard.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { authError } from '../auth/transport';

interface DashboardMetrics {
  totalStudents: number;
  totalStaff: number;
  inventoryCount: number;
  recentActivities: string[];
}

const Dashboard = () => {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setError('');
    try {
      const response = await axios.get<DashboardMetrics>(`${API_BASE_URL}/api/dashboard`, { signal: request.signal });
      if (!request.signal.aborted) setMetrics(response.data);
    } catch (failure) {
      if (!request.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load the dashboard.'));
    }
  }, []);
  useEffect(() => { void refresh(); return () => pending.current?.abort(); }, [refresh]);

  if (error) return <div className="space-y-3 p-6"><p role="alert">{error}</p><button onClick={() => void refresh()} className="rounded border bg-white px-4 py-2">Retry dashboard</button></div>;
  if (!metrics) return <p className="p-6">Loading dashboard...</p>;

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-bold text-gray-800">Dashboard Overview</h2>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <MetricCard label="Total Students" value={metrics.totalStudents} />
        <MetricCard label="Active Staff" value={metrics.totalStaff} />
        <MetricCard label="Inventory Items" value={metrics.inventoryCount} />
      </div>

      <div className="bg-white rounded shadow p-4">
        <h3 className="text-lg font-semibold mb-2 text-gray-800">Recent Activities</h3>
        {metrics.recentActivities?.length ? (
          <ul className="list-disc list-inside text-gray-700 space-y-1">
            {metrics.recentActivities.map((activity, index) => (
              <li key={index}>{activity}</li>
            ))}
          </ul>
        ) : (
          <p className="text-gray-500">No recent activities available.</p>
        )}
      </div>
    </div>
  );
};

const MetricCard = ({ label, value }: { label: string; value: number }) => (
  <div className="bg-white rounded shadow p-4 text-center">
    <p className="text-sm text-gray-500">{label}</p>
    <p className="text-2xl font-bold text-gray-900">{value}</p>
  </div>
);

export default Dashboard;
