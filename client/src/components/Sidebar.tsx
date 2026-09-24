// src/components/Sidebar.tsx
import { useAuth } from "../auth/context";
import { NavLink } from "react-router-dom";
import { getNavigationItems } from "./navigation";

export default function Sidebar() {
  const { account } = useAuth();
  const items = getNavigationItems(account?.role);
  return (
    <aside className="app-sidebar hidden w-72 shrink-0 bg-slate-950 p-6 text-white md:block print:hidden">
      <nav aria-label="Desktop navigation" className="space-y-3">
        {items.map((item) => (
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
            <item.icon size={20} aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
