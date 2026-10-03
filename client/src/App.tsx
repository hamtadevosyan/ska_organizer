// src/App.tsx
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import AuthProvider from "./auth/AuthProvider";
import AuthGate from "./auth/AuthGate";
import AppShell from "./components/AppShell";
import AppRoutes from "./router"; // router file
import PwaProvider from "./pwa/PwaProvider";

import UnsavedChangesProvider from "./components/UnsavedChangesProvider";

const router = createBrowserRouter([{ path: "*", element:
  <UnsavedChangesProvider><AppShell><AppRoutes /></AppShell></UnsavedChangesProvider>,
}]);

const App = () => {
  return (
    <PwaProvider><AuthProvider><AuthGate><RouterProvider router={router} /></AuthGate></AuthProvider></PwaProvider>
  );
};

export default App;
