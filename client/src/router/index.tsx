import { Routes, Route, Navigate } from "react-router-dom";

import Dashboard from "../pages/Dashboard";
import Inventory from "../pages/Inventory";
import Activities from "../pages/Activities";
import Meals from "../pages/Meals";
import Staff from "../pages/Staff";
import Reports from "../pages/Reports";
import SchedulePage from "../pages/SchedulePage";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/inventory" element={<Inventory />} />
      <Route path="/activities" element={<Activities />} />
      <Route path="/schedule" element={<SchedulePage />} />
      <Route path="/meals" element={<Meals />} />
      <Route path="/staff" element={<Staff />} />
      <Route path="/reports" element={<Reports />} />
    </Routes>
  );
}
