import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

interface ActivityPlanItem {
  day: string;
  activity: string;
}

const getWeekStart = (): string => {
  const today = new Date();
  const day = today.getDay(); // 0 = Sunday, 1 = Monday
  const diff = today.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(today);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
};

const Activities = () => {
  const [activityPlan, setActivityPlan] = useState<ActivityPlanItem[]>([]);
  const [loading, setLoading] = useState(true);

  // temporary default until we connect rooms UI/state
  const roomId = 1;
  const weekStart = getWeekStart();

  useEffect(() => {
    axios
      .get(`${API_BASE_URL}/api/activity/generate`, {
        params: {
          roomId,
          weekStart,
        },
      })
      .then((res) => setActivityPlan(res.data.data || []))
      .catch((err) => console.error('Failed to fetch activity plan:', err))
      .finally(() => setLoading(false));
  }, [roomId, weekStart]);

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-2xl font-bold">Weekly Activity Plan</h2>

      {loading ? (
        <p>Loading...</p>
      ) : activityPlan.length === 0 ? (
        <p className="text-gray-500">No activity plan available.</p>
      ) : (
        <ul className="space-y-2">
          {activityPlan.map((item, index) => (
            <li key={index} className="bg-white rounded shadow p-4">
              <p className="font-semibold text-gray-800">{item.day}</p>
              <p className="text-gray-600">{item.activity}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default Activities;
