// Entry point. Font CSS is intentionally NOT imported here — every
// eager `@fontsource/*` import pulls a woff2 binary onto the first-paint
// critical path and competes with JS parse/execute on cold start (#255).
// Webfonts are now loaded lazily by `settingsStore.init()` + the font
// setters, so only the family actually selected by the user is fetched,
// and even that happens after Svelte mount instead of before it.
import { mount } from 'svelte';
import './styles/tailwind.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Root element #app not found in index.html');
const app = mount(App, { target });

export default app;
