import React from "react";

const DashboardContent = () => {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Attendance Card */}
      <div className="bg-white rounded-lg shadow p-6">
        <h4 className="text-lg font-semibold mb-2">Attendance</h4>
        <div className="flex space-x-8 text-center">
          <div>
            <div className="text-3xl font-bold text-gray-900">45</div>
            <div className="text-sm text-gray-500">Checked In</div>
          </div>
          <div>
            <div className="text-3xl font-bold text-gray-900">12</div>
            <div className="text-sm text-gray-500">Absent</div>
          </div>
        </div>
      </div>

      {/* Inventory Card */}
      <div className="bg-white rounded-lg shadow p-6">
        <h4 className="text-lg font-semibold mb-2">Inventory Status</h4>
        <ul className="text-sm text-gray-700 space-y-1">
          <li>• 5 Low Stock Items — <a href="#" className="text-blue-600">Arts and Crafts</a></li>
          <li>• 2 Out of Stock Items — <a href="#" className="text-blue-600">Supply Room</a></li>
        </ul>
      </div>

      {/* Activity Planner */}
      <div className="bg-white rounded-lg shadow p-6">
        <h4 className="text-lg font-semibold mb-2">Activity Planner</h4>
        <p className="text-sm text-gray-600 mb-4">No activities planned for today.</p>
        <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">
          Generate Activities
        </button>
      </div>

      {/* Daily Schedule */}
      <div className="bg-white rounded-lg shadow p-6">
        <h4 className="text-lg font-semibold mb-2">Daily Schedule</h4>
        <ul className="text-sm text-gray-700 space-y-1">
          <li><strong>8:00 AM</strong> — Circle Time (Preschool)</li>
          <li><strong>9:00 AM</strong> — Snack Time</li>
          <li><strong>10:00 AM</strong> — Arts & Crafts (Toddlers)</li>
          <li><strong>11:00 AM</strong> — Story Time (Pre-K)</li>
        </ul>
      </div>
    </div>
  );
};

export default DashboardContent;

