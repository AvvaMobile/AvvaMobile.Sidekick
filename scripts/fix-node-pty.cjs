// node-pty's macOS prebuilds ship spawn-helper without the executable bit; without it every
// PTY spawn fails with "posix_spawnp failed". Runs after npm install.
const { chmodSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
if (existsSync(root)) {
  for (const dir of readdirSync(root)) {
    const helper = join(root, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
