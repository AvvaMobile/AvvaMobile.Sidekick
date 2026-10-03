// Development-only: creates `.dev/Avva Mobile Sidekick.app`, an APFS clone of the stock Electron.app
// with the product name, bundle id and icon, so the Dock, app switcher and menu bar show
// "Avva Mobile Sidekick" instead of "Electron" during `npm run app`. Packaging replaces this later.
const { execFileSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

if (process.platform !== 'darwin') process.exit(0);

const NAME = 'Avva Mobile Sidekick';
const BUNDLE_ID = 'com.avvamobile.sidekick.dev';
const root = join(__dirname, '..');
const src = join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const dest = join(root, '.dev', `${NAME}.app`);
const icon = join(root, 'build', 'icon.icns');
const stamp = join(root, '.dev', 'bundle.stamp');

const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const wanted = JSON.stringify({ electronVersion, NAME, BUNDLE_ID, icon: existsSync(icon) ? statSync(icon).mtimeMs : 0 });
if (existsSync(dest) && existsSync(stamp) && readFileSync(stamp, 'utf8') === wanted) process.exit(0);

rmSync(dest, { recursive: true, force: true });
mkdirSync(join(root, '.dev'), { recursive: true });
// -c: APFS clone (no extra disk space); falls back to a normal copy on other file systems.
try {
  execFileSync('cp', ['-cR', src, dest]);
} catch {
  execFileSync('cp', ['-R', src, dest]);
}
const plist = join(dest, 'Contents', 'Info.plist');
const set = (key, value) => execFileSync('plutil', ['-replace', key, '-string', value, plist]);
set('CFBundleName', NAME);
set('CFBundleDisplayName', NAME);
set('CFBundleIdentifier', BUNDLE_ID);
if (existsSync(icon)) copyFileSync(icon, join(dest, 'Contents', 'Resources', 'electron.icns'));
// The stock bundle is ad-hoc signed; re-sign ad-hoc after editing Info.plist/resources.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', dest], { stdio: 'ignore' });
try {
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', dest]);
} catch {
  // Registration only refreshes Finder/Dock caches.
}
writeFileSync(stamp, wanted);
console.log(`dev bundle ready: ${dest}`);
