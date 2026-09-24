// src/App.tsx
import { BrowserRouter } from "react-router-dom";

import AuthProvider from "./auth/AuthProvider";
import AuthGate from "./auth/AuthGate";
import AppShell from "./components/AppShell";
import AppRoutes from "./router"; // router file

const App = () => {
  return (
    <AuthProvider><AuthGate><BrowserRouter>
      <AppShell><AppRoutes /></AppShell>
    </BrowserRouter></AuthGate></AuthProvider>
  );
};

export default App;
