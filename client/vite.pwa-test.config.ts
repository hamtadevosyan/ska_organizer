import { defineConfig } from 'vite';

// Production build + same-origin API in a disposable loopback test fixture.
export default defineConfig({ preview: { proxy: { '/api': { target: 'http://127.0.0.1:3009' } } } });
