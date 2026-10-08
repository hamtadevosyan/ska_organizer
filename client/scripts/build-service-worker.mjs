import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const client = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(client, 'dist');
const template = await readFile(join(client, 'pwa/service-worker.js'), 'utf8');
const paths = ['/index.html'];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && /\.(?:m?js|css|woff2?|ttf|otf|pfb|png|jpe?g|webp|avif|gif|svg|ico)$/.test(entry.name)) {
      paths.push('/' + relative(dist, path).split('\\').join('/'));
    }
  }
}
await collect(join(dist, 'assets'));
const manifest = await Promise.all(paths.sort().map(async url => ({ url,
  sha256: createHash('sha256').update(await readFile(join(dist, url.slice(1)))).digest('hex'),
})));
const json = JSON.stringify(manifest);
const version = createHash('sha256').update(template).update(json).digest('hex').slice(0, 20);
await writeFile(join(dist, 'sw.js'), template.replace('__SKAO_STATIC_FILES__', json)
  .replace('__SKAO_CACHE_NAME__', 'skao-static-v1-' + version));
console.log(`Static-only service worker: ${manifest.length} verified public build files.`);
