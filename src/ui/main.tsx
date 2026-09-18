import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/marcellus/400.css';
import '@fontsource-variable/source-sans-3/wght.css';
import '@fontsource-variable/source-code-pro/wght.css';
import { App } from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
