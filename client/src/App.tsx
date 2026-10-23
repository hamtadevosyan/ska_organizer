// src/App.tsx
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import AuthProvider from "./auth/AuthProvider";
import AuthGate from "./auth/AuthGate";
import AppShell from "./components/AppShell";
import AppRoutes from "./router"; // router file
import PwaProvider from "./pwa/PwaProvider";

import UnsavedChangesProvider from "./components/UnsavedChangesProvider";
import TimeClockStation from "./pages/TimeClockStation";

const router = createBrowserRouter([
  { path: "/time-clock", element: <TimeClockStation /> },
  { path: "*", element: <AuthProvider><AuthGate>
    <UnsavedChangesProvider><AppShell><AppRoutes /></AppShell></UnsavedChangesProvider>
  </AuthGate></AuthProvider> },
]);

const App = () => {
  return (
    <PwaProvider><RouterProvider router={router} /></PwaProvider>
  );
};

export default App;
