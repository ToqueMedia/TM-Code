import { defineConfig } from 'astro/config';

export default defineConfig({
  vite: {
    server: {
      cors: true,
    },
  },
});
