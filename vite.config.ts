import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'node:child_process';

function git(cmd: string): string | null {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const count = git('rev-list --count HEAD');
const sha = git('rev-parse --short HEAD');
const date = git('log -1 --format=%cI');
const buildVersion =
  count && sha && date ? `${count}-g${sha} · ${date.slice(0, 10)}` : 'dev';

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  define: {
    __VC_BUILD_VERSION__: JSON.stringify(buildVersion),
  },
});
