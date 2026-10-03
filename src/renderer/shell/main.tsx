import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api } from './api';

// Window chrome differs per platform (macOS traffic lights on the left, Windows caption buttons on the right).
document.documentElement.classList.add(`platform-${api.platform}`);

// A file dropped anywhere the app does not accept drops must not navigate the window to it.
const isFileDrag = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
document.addEventListener('dragover', (e) => {
  if (e.defaultPrevented || !isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'none';
});
document.addEventListener('drop', (e) => {
  if (!e.defaultPrevented && isFileDrag(e)) e.preventDefault();
});

createRoot(document.getElementById('root')!).render(<App api={api} />);
