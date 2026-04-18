// src/App.tsx
import React, { useState } from "react";
import { BrowserRouter } from "react-router-dom";

import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import AppRoutes from "./router"; // router file

const App = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <BrowserRouter>
      <div className="h-screen flex flex-col">
        <Topbar onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />

        <div className="flex flex-1 bg-gray-100">
          <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

          <main className="flex-1 p-4 overflow-y-auto">
            <AppRoutes />
          </main>
        </div>
      </div>
    </BrowserRouter>
  );
};

export default App;

