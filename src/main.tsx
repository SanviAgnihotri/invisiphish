import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App from '@/App';
import '@/index.css';

const container = document.getElementById('root')!;
const tree = (
  <StrictMode>
    <App />
  </StrictMode>
);

/**
 * The public pages are prebuilt: their markup is already in the document
 * before this script runs, so the browser can paint them straight away.
 * React hydrates that markup instead of throwing it away and rendering the
 * same thing again a moment later.
 */
if (container.dataset.prerendered === 'true') {
  hydrateRoot(container, tree);
} else {
  createRoot(container).render(tree);
}
