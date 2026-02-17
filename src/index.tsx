import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { ensureSessionIdInHash } from './utils/sessionStore';

// Ensure URL hash has a session ID (Perfetto-style). Redirects if missing.
ensureSessionIdInHash();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
