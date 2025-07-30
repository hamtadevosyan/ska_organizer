// src/components/Topbar.tsx
import React from "react";
import { Menu } from "lucide-react";

const Topbar = ({ onToggleSidebar }) => {
  return (
    <header className="flex justify-between items-center px-6 py-4 bg-white shadow-sm border-b">
      <div className="flex items-center space-x-4">
        {/* Hamburger Icon (Mobile) */}
        <button
          onClick={onToggleSidebar}
          className="md:hidden p-2 text-gray-700 hover:bg-gray-200 rounded"
        >
          <Menu size={24} />
        </button>
        <h1 className="text-xl font-bold text-gray-900 font-serif">
          Smart Kids Academy
        </h1>
      </div>

      <div className="flex items-center space-x-4">
        <select className="border rounded px-2 py-1 text-sm">
          <option>English</option>
          <option>Spanish</option>
        </select>
        <span className="text-sm text-gray-700">Admin</span>
      </div>
    </header>
  );
};

export default Topbar;

