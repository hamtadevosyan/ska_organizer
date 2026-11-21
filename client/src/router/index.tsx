import OrganizerAssistant from "../pages/OrganizerAssistant";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";

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
import Billing from "../pages/Billing";
import CCRCStatements from "../pages/CCRCStatements";
import { useAuth } from "../auth/context";

import WorkTime from "../pages/WorkTime";
import Payroll from "../pages/Payroll";
import MyTime from "../pages/MyTime";
import StaffLayout from "../components/staff/StaffLayout";
import StaffClock from "../components/staff/StaffClock";
import ClockStationSetup from "../components/staff/ClockStationSetup";

function StaffRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}

export default function AppRoutes() {
  const { account } = useAuth();
  // Resolve viewer routes before any operational page mounts or requests data.
  if ((account?.role === 'viewer' || account?.role === 'teacher')) return <Routes>
    <Route path="/assistant" element={<OrganizerAssistant />} />
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
      <Route path="/assistant" element={<OrganizerAssistant />} />
    <Route path="/my-time" element={<MyTime />} />
      <Route path="/payroll" element={<StaffRedirect to="/staff/payroll" />} />
      <Route path="/work-time" element={<StaffRedirect to="/staff/work-time" />} />
      <Route path="/accounts" element={<Accounts />} />
      <Route path="/registration-forms" element={<RegistrationForms />} />
      <Route path="/rooms" element={<Rooms />} />
      <Route path="/rooms/:roomId" element={<RoomRoster />} />
      <Route path="/children" element={<Children />} />
      <Route path="/billing/ccrc-statements" element={account?.role === 'admin' ? <CCRCStatements /> : <Navigate to="/children" replace />} />
      <Route path="/billing" element={account?.role === 'admin' ? <Billing /> : <Navigate to="/children" replace />} />
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
      <Route path="/staff" element={<StaffLayout />}>
        <Route index element={<Staff />} />
        <Route path="clock" element={<StaffClock />} />
        <Route path="clock-station" element={account?.role === 'admin' ? <ClockStationSetup /> : <Navigate to="/staff/clock" replace />} />
        <Route path="work-time" element={<WorkTime />} />
        <Route path="payroll" element={<Payroll />} />
      </Route>
      <Route path="/reports" element={<Reports />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
