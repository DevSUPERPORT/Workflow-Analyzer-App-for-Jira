/**
 * Custom UI entry point: loads the bundled Geist fonts and the stylesheet and mounts the React app.
 *
 * @file        static/app/src/main.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);
