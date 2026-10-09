import { Routes, Route, Navigate } from "react-router-dom";

import Accounts from "../pages/Accounts";
import RegistrationForms from "../pages/RegistrationForms";
import Rooms from "../pages/Rooms";
import RoomRoster from "../pages/RoomRoster";
import Children from "../pages/Children";
import Attendance from "../pages/Attendance";
import Dashboard from "../pages/Dashboard";
import Inventory from "../pages/Inventory";
import Activities from "../pages/Activities";
import Meals from "../pages/Meals";
import Staff from "../pages/Staff";
import Reports from "../pages/Reports";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/accounts" element={<Accounts />} />
      <Route path="/registration-forms" element={<RegistrationForms />} />
      <Route path="/rooms" element={<Rooms />} />
      <Route path="/rooms/:roomId" element={<RoomRoster />} />
      <Route path="/children" element={<Children />} />
      <Route path="/attendance" element={<Attendance />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/inventory" element={<Inventory />} />
      <Route path="/activities" element={<Activities />} />
      <Route path="/schedule" element={<Navigate to="/activities" replace />} />
      <Route path="/meals" element={<Meals />} />
      <Route path="/staff" element={<Staff />} />
      <Route path="/reports" element={<Reports />} />
    </Routes>
  );
}
