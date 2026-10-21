import { Routes, Route, Navigate } from "react-router-dom";

import Accounts from "../pages/Accounts";
import RegistrationForms from "../pages/RegistrationForms";
import Rooms from "../pages/Rooms";
import RoomRoster from "../pages/RoomRoster";
import Children from "../pages/Children";
import Attendance from "../pages/Attendance";
import Dashboard from "../pages/Dashboard";
import Inventory from "../pages/Inventory";
import InventoryGroupOperation from "../pages/InventoryGroupOperation";
import Purchasing from "../pages/Purchasing";
import Receiving from "../pages/Receiving";
import Activities from "../pages/Activities";
import Meals from "../pages/Meals";
import Staff from "../pages/Staff";
import Reports from "../pages/Reports";
import Classroom from "../pages/Classroom";
import TeacherCare from "../pages/TeacherCare";
import { useAuth } from "../auth/context";

import Payroll from "../pages/Payroll";
import MyTime from "../pages/MyTime";

export default function AppRoutes() {
  const { account } = useAuth();
  // Resolve viewer routes before any operational page mounts or requests data.
  if ((account?.role === 'viewer' || account?.role === 'teacher')) return <Routes>
    <Route path="/my-time" element={<MyTime />} />
    <Route path="/classroom" element={<Classroom section="overview" />} />
    <Route path="/classroom/children" element={account.role === 'teacher' ? <TeacherCare section="children" /> : <Classroom section="children" />} />
    {account.role === 'teacher' && <Route path="/classroom/attendance" element={<TeacherCare section="attendance" />} />}
    <Route path="/classroom/activities" element={<Classroom section="activities" />} />
    <Route path="/classroom/meals" element={<Classroom section="meals" />} />
    <Route path="*" element={<Navigate to="/classroom" replace />} />
  </Routes>;
  return (
    <Routes>
      <Route path="/my-time" element={<MyTime />} />
      <Route path="/payroll" element={<Payroll />} />
      <Route path="/accounts" element={<Accounts />} />
      <Route path="/registration-forms" element={<RegistrationForms />} />
      <Route path="/rooms" element={<Rooms />} />
      <Route path="/rooms/:roomId" element={<RoomRoster />} />
      <Route path="/children" element={<Children />} />
      <Route path="/attendance" element={<Attendance />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/inventory" element={<Inventory />} />
      <Route path="/inventory/group-operations/:id" element={<InventoryGroupOperation />} />
      <Route path="/purchasing" element={<Purchasing />} />
      <Route path="/receiving" element={<Receiving />} />
      <Route path="/activities" element={<Activities />} />
      <Route path="/schedule" element={<Navigate to="/activities" replace />} />
      <Route path="/meals" element={<Meals />} />
      <Route path="/staff" element={<Staff />} />
      <Route path="/reports" element={<Reports />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
