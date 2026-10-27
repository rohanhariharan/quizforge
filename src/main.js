import './styles.css';
import { boot } from './ui/app.js';

boot().catch((error) => {
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = `<main class="screen error-screen"><div class="error-card"><h1>QuizForge could not start</h1><p class="error-message">${String(error?.message || error)}</p></div></main>`;
  }
});
