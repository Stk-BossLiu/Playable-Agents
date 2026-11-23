import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const failures = [];

function requireFile(label, file) {
  if (!existsSync(file)) {
    failures.push(`${label} missing: ${file}`);
    return false;
  }
  return true;
}

const mainFile = join(root, pkg.main);
const sceneFile = join(root, pkg.contributions?.scene?.script ?? '');
const agentFile = join(dist, 'cocos-tools.js');

requireFile('main', mainFile);
for (const [name, panel] of Object.entries(pkg.panels ?? {})) {
  requireFile(`panel:${name}`, join(root, panel.main));
}
requireFile('scene-script', sceneFile);
requireFile('agent', agentFile);

// 所有协议消息必须先注册，否则 Editor.Message.send/request 会抛 Message does not exist。
const messages = pkg.contributions?.messages ?? {};
const requiredMessages = [
  'open-panel',
  'panel-event',
  'panel-ready',
  'panel-closed',
  'app-info',
  'approval-respond',
  'graph-list',
  'graph-load',
  'graph-save',
  'graph-create',
  'graph-delete',
  'graph-import',
  'graph-export',
  'graph-duplicate',
  'graph-validate',
  'graph-node-types',
  'graph-run',
  'graph-run-pause',
  'graph-run-resume',
  'graph-run-cancel',
  'graph-human-respond',
  'graph-run-list',
  'graph-run-load',
  'graph-artifact-read',
  'graph-run-delete',
  'settings-get',
  'settings-set',
  'model-profiles-get',
  'model-profile-save',
  'model-profile-delete',
  'model-profile-validate',
  'model-profile-apply',
  'model-defaults-set',
  'dependencies-get',
  'pi-download',
  'pi-select-path',
  'agent-start',
  'agent-stop',
  'agent-restart',
  'agent-status',
  'agent-prompt',
  'agent-steer',
  'agent-follow-up',
  'agent-abort',
  'agent-clear-queue',
  'agent-state',
  'agent-messages',
  'agent-set-model',
  'agent-models',
  'agent-set-thinking',
  'agent-thinking-levels',
  'agent-commands',
  'agent-compact',
  'agent-export',
  'agent-stats',
  'agent-new-session',
  'agent-sessions',
  'agent-switch-session',
];
for (const name of requiredMessages) {
  if (!messages[name]) failures.push(`contributions.messages.${name} is not registered`);
}
const panelEventMethods = Array.isArray(messages['panel-event']?.methods) ? messages['panel-event'].methods : [];
if (!panelEventMethods.includes('default.onPanelEvent')) {
  failures.push('contributions.messages.panel-event must route to default.onPanelEvent');
}

// Pi 用 jiti 加载扩展；把 CJS 的 exports.default 适配成 module.exports，最稳妥。
if (existsSync(agentFile)) {
  let code = readFileSync(agentFile, 'utf8');
  if (/\bexports\.default\s*=/.test(code) && !/\bmodule\.exports\s*=/.test(code)) {
    code += '\nmodule.exports = exports.default;\n';
    writeFileSync(agentFile, code, 'utf8');
  }
}

for (const [name, panel] of Object.entries(pkg.panels ?? {})) {
  const file = join(root, panel.main);
  if (!existsSync(file)) continue;
  const panelCode = readFileSync(file, 'utf8');
  if (!/\bmodule\.exports\s*=/.test(panelCode)) {
    failures.push(`panel bundle ${name} does not assign module.exports (Editor.Panel.define output expected)`);
  }
}

writeFileSync(
  join(dist, 'build-info.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      editor: pkg.editor,
      builtAt: new Date().toISOString(),
      entries: {
        main: pkg.main,
        panels: Object.fromEntries(Object.entries(pkg.panels ?? {}).map(([name, panel]) => [name, panel.main])),
        sceneScript: pkg.contributions?.scene?.script,
        agent: './dist/cocos-tools.js',
      },
    },
    null,
    2,
  ),
  'utf8',
);

if (failures.length > 0) {
  console.error('[postbuild] failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('[postbuild] ok');
