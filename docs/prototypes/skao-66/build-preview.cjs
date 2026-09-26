const fs = require('node:fs');
const path = require('node:path');

const output = process.argv[2];
if (!output) throw new Error('Usage: node docs/prototypes/skao-66/build-preview.cjs OUTPUT.html');
const root = path.resolve(__dirname, '../../..');
let html = fs.readFileSync(path.join(__dirname, 'planner-template.html'), 'utf8');
for (const [token, file] of [
  ['LOCAL_FONT', 'PlusJakartaSans-variable.ttf'],
  ['LOCAL_LOGO', 'academy-logo.png'],
]) html = html.replace(`{{${token}}}`, fs.readFileSync(path.join(root, 'client/src/assets/brand', file)).toString('base64'));
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, html);
console.log(`Built ${path.basename(output)} (${Buffer.byteLength(html)} bytes); all assets embedded.`);
