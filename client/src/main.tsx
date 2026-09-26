// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { registerStaticWorker } from './pwa/register';
import './index.css';
import './styles/theme.css';
import './styles/core-screens.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

registerStaticWorker();
