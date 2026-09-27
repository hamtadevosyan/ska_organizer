// src/App.tsx
import { BrowserRouter } from "react-router-dom";

import AuthProvider from "./auth/AuthProvider";
import AuthGate from "./auth/AuthGate";
import AppShell from "./components/AppShell";
import AppRoutes from "./router"; // router file
import PwaProvider from "./pwa/PwaProvider";

const App = () => {
  return (
    <PwaProvider><AuthProvider><AuthGate><BrowserRouter>
      <AppShell><AppRoutes /></AppShell>
    </BrowserRouter></AuthGate></AuthProvider></PwaProvider>
  );
};

export default App;
