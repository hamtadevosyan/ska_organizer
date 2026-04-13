// src/pages/Activities.tsx
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';

const Activities = () => {
  const [activityPlan, setActivityPlan] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    axios
      .get(`${API_BASE_URL}/api/activity/generate`)
      .then((res) => setActivityPlan(res.data.plan))
      .catch((err) => console.error('Failed to fetch activity plan:', err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-2xl font-bold">Weekly Activity Plan</h2>
      {loading ? (
        <p>Loading...</p>
      ) : (
        <ul className="list-disc list-inside space-y-1">
          {activityPlan.map((activity, index) => (
            <li key={index}>{activity}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default Activities;

