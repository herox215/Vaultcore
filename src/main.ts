import { mount } from 'svelte';
import './styles/tailwind.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Root element #app not found in index.html');
const app = mount(App, { target });

export default app;
