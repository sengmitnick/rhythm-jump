// Create the git-ignored local service config from the committed example.
// The file is never overwritten, so a filled-in config survives upgrades.
import { copyFile, mkdir, access, constants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const example = path.join(root, 'config', 'service-config.example.js');
const target = path.join(root, 'src', 'lib', 'service-config.local.js');

try {
  await access(target, constants.F_OK);
  console.log('service config: using existing src/lib/service-config.local.js');
} catch {
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(example, target);
  console.log('service config: created src/lib/service-config.local.js from the example');
  console.log('service config: set your own agentId there; the file is git-ignored');
}
