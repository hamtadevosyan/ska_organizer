// src/pages/Dashboard.tsx
import React, { useEffect, useState } from 'react';
import axios from 'axios';

interface DashboardMetrics {
  totalStudents: number;
  totalStaff: number;
  inventoryCount: number;
  recentActivities: string[];
}

const Dashboard = () => {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);

  useEffect(() => {
    axios
      .get('http://192.168.33.132:3001/api/dashboard') // <- Update this to your actual backend IP
      .then((res) => setMetrics(res.data))
      .catch((err) => console.error('Failed to fetch metrics:', err));
  }, []);

  if (!metrics) return <p className="p-6">Loading dashboard...</p>;

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-bold text-gray-800">Dashboard Overview</h2>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <MetricCard label="Total Students" value={metrics.totalStudents} />
        <MetricCard label="Total Staff" value={metrics.totalStaff} />
        <MetricCard label="Inventory Items" value={metrics.inventoryCount} />
      </div>

      <div className="bg-white rounded shadow p-4">
        <h3 className="text-lg font-semibold mb-2 text-gray-800">Recent Activities</h3>
        <ul className="list-disc list-inside text-gray-700 space-y-1">
          {metrics.recentActivities.map((activity, index) => (
            <li key={index}>{activity}</li>
          ))}
        </ul>
      </div>
    </div>
  );
};

const MetricCard = ({ label, value }: { label: string; value: number }) => (
  <div className="bg-white rounded shadow p-4 text-center">
    <p className="text-sm text-gray-500">{label}</p>
    <p className="text-3xl font-bold text-indigo-600">{value}</p>
  </div>
);

export default Dashboard;

