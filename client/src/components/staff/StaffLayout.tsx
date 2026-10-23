import { ClipboardCheck, Clock3, FileText, Tablet, Users } from 'lucide-react';
import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../auth/context';
import './staff-sections.css';

export default function StaffLayout() {
  const { account } = useAuth();
  if (!account || !['admin', 'editor'].includes(account.role)) return <Navigate to="/dashboard" replace />;
  return <div className="staff-workspace">
    <nav aria-label="Staff sections" className="staff-sections print:hidden">
      <NavLink to="/staff" end><Users size={19} aria-hidden="true" /><span>Staff information</span></NavLink>
      <NavLink to="/staff/clock"><Clock3 size={19} aria-hidden="true" /><span>Clock in/out</span></NavLink>
      <NavLink to="/staff/work-time"><ClipboardCheck size={19} aria-hidden="true" /><span>Work time</span></NavLink>
      {account.role === 'admin' && <NavLink to="/staff/payroll"><FileText size={19} aria-hidden="true" /><span>Pay &amp; time</span></NavLink>}
      {account.role === 'admin' && <NavLink to="/staff/clock-station"><Tablet size={19} aria-hidden="true" /><span>Clock station</span></NavLink>}
    </nav>
    <Outlet />
  </div>;
}
