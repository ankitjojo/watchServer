import { cp, mkdir } from 'node:fs/promises';

// Views and public assets are not compiled by tsc; copy them next to dist/.
await mkdir('dist', { recursive: true });
await cp('src/views', 'dist/views', { recursive: true });
await cp('src/public', 'dist/public', { recursive: true });
