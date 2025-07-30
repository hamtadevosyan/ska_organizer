// src/components/Sidebar.tsx
import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Boxes,
  Calendar,
  Utensils,
  Users,
  FileText,
  X,
} from 'lucide-react';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose }) => {
  return (
    <>
      {/* Overlay for mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar container */}
      <aside
        className={`fixed z-50 md:static top-0 left-0 h-full bg-[#0F172A] text-white w-64 p-6 transform transition-transform duration-200 ease-in-out ${
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        {/* Close button for mobile */}
        <div className="flex justify-end md:hidden">
          <button onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <nav className="space-y-4 mt-4 md:mt-0">
          <NavItem to="/" icon={<LayoutDashboard size={18} />} label="Dashboard" />
          <NavItem to="/inventory" icon={<Boxes size={18} />} label="Inventory" />
          <NavItem to="/activities" icon={<Calendar size={18} />} label="Activity Planner" />
          <NavItem to="/meals" icon={<Utensils size={18} />} label="Meal Planner" />
          <NavItem to="/staff" icon={<Users size={18} />} label="Staff" />
          <NavItem to="/reports" icon={<FileText size={18} />} label="Reports" />
        </nav>
      </aside>
    </>
  );
};

const NavItem = ({
  to,
  icon,
  label,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
}) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `flex items-center space-x-3 px-3 py-2 rounded text-sm hover:bg-slate-700 transition ${
        isActive ? 'bg-slate-700' : ''
      }`
    }
  >
    {icon}
    <span>{label}</span>
  </NavLink>
);

export default Sidebar;

