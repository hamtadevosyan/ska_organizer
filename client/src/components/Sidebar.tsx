// src/components/Sidebar.tsx
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Boxes,
  CalendarDays,
  Utensils,
  Users,
  FileText,
} from "lucide-react";

const navItems = [
  {
    to: "/dashboard",
    label: "Dashboard",
    icon: <LayoutDashboard size={20} />,
  },
  {
    to: "/inventory",
    label: "Inventory",
    icon: <Boxes size={20} />,
  },
  {
    to: "/activities",
    label: "Activity Planner",
    icon: <CalendarDays size={20} />,
  },
  {
    to: "/meals",
    label: "Meals",
    icon: <Utensils size={20} />,
  },
  {
    to: "/staff",
    label: "Staff",
    icon: <Users size={20} />,
  },
  {
    to: "/reports",
    label: "Reports",
    icon: <FileText size={20} />,
  },
];

export default function Sidebar() {
  return (
    <aside className="w-72 min-h-screen bg-slate-950 text-white p-6">
      <nav className="space-y-3">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-4 rounded-xl px-4 py-3 text-sm font-semibold transition ${
                isActive
                  ? "bg-slate-700 text-white"
                  : "text-slate-200 hover:bg-slate-800 hover:text-white"
              }`
            }
          >
            {item.icon}
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
