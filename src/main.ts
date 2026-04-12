// @fontsource CSS must precede Tailwind to keep @font-face declarations intact (RESEARCH Pitfall 7).
// 400 = regular, 700 = bold. MVP ships these two weights only per D-08.
import "@fontsource/inter/400.css";
import "@fontsource/inter/700.css";
import "@fontsource/lora/400.css";
import "@fontsource/lora/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import { mount } from 'svelte';
import './styles/tailwind.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Root element #app not found in index.html');
const app = mount(App, { target });

export default app;
