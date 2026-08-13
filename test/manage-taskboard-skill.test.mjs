import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);
const cliReference = await readFile(
  new URL("../skills/manage-taskboard/references/cli.md", import.meta.url),
  "utf8",
);
const installerSource = await readFile(
  new URL("../scripts/codex-plugin-install.mjs", import.meta.url),
  "utf8",
);
const launcherSource = await readFile(
  new URL("../scripts/dashi-taskboard.mjs", import.meta.url),
  "utf8",
);
const windowsBrokerSource = await readFile(
  new URL("../scripts/windows-taskboard-broker.mjs", import.meta.url),
  "utf8",
);
const doctorSource = await readFile(
  new URL("../scripts/codex-plugin-doctor.mjs", import.meta.url),
  "utf8",
);

test("the taskboard skill coordinates safe issue execution and review handoff", () => {
  assert.match(skillSource, /read the latest issue content and all comments/i);
  assert.match(skillSource, /completed work.*returned|returned.*completed work/i);
  assert.match(skillSource, /claim.*`todo`.*`in_progress`.*`--if-version`/is);
  assert.match(skillSource, /version conflict.*skip the issue.*do not implement/is);

  assert.match(
    skillSource,
    /after implementation[^\n]*add a comment[^\n]*key changes[^\n]*verification[^\n]*result[^\n]*risks[^\n]*then move[^\n]*`in_review`/i,
  );
});

test("the taskboard skill creates cards before implementation for planning requests", () => {
  assert.match(skillSource, /## Planning First/);
  assert.match(skillSource, /create or update task cards before doing implementation work/i);
  assert.match(skillSource, /Do not start editing code/i);
  assert.match(skillSource, /taskctl context current --cwd <cwd> --json/);
  assert.match(skillSource, /taskctl issue list --project <projectId> --json/);
  assert.match(skillSource, /parent card/i);
  assert.match(skillSource, /child cards/i);
  assert.match(skillSource, /issue relation add --type parent/);
  assert.match(skillSource, /Stop and summarize the created or updated cards/i);
  assert.match(skillSource, /unless the user explicitly asked to create cards and then start/i);
});

test("the taskboard skill can bootstrap install then open the standalone panel", () => {
  for (const source of [skillSource, cliReference]) {
    assert.match(source, /command -v dashi-taskboard|dashi-taskboard` is not installed/i);
    assert.match(source, /git clone https:\/\/git\.caijai\.com\/aiplus\/cjtaskdashboard\.git/);
    assert.match(source, /CJ Task Dashboard/);
    assert.match(source, /npm run install:codex-plugin/);
    assert.match(source, /dashi-taskboard doctor/);
    assert.match(source, /dashi-taskboard open/);
  }
  assert.match(skillSource, /private/i);
});

test("the default installer keeps Codex sidebar injection optional", () => {
  assert.doesNotMatch(installerSource, /installDashiCodexShim/);
  assert.match(installerSource, /await rm\(injectorPlistPath, \{ force: true \}\)/);
  assert.match(installerSource, /installed: false/);
  assert.doesNotMatch(installerSource, /"com\.dashi-taskboard\.codex-injector",\s*\[/);
  assert.match(doctorSource, /required: false/);
  assert.doesNotMatch(doctorSource, /&& checks\.dashiCodex\.exists/);
});

test("opening the standalone panel focuses an existing macOS window instead of duplicating it", () => {
  assert.match(launcherSource, /focusExistingPanelWindow\(browser\.name, url\)/);
  assert.match(launcherSource, /method: "macos-focus-existing"/);
  assert.match(launcherSource, /focusExistingPanelSystemWindow\(browserName\)/);
  assert.match(launcherSource, /set targetTitle to "Taskboard"/);
  assert.doesNotMatch(launcherSource, /"-n"/);
  assert.match(launcherSource, /openBrowserAppWindow\(browser\.executablePath, url\)/);
  assert.match(launcherSource, /`--app=\$\{url\}`/);
  assert.match(launcherSource, /"--new-window"/);
  assert.match(launcherSource, /method: "windows-browser-app-window"/);
  assert.match(launcherSource, /focusExistingWindowsPanelWindow\(url\)/);
  assert.match(launcherSource, /method: "windows-focus-existing"/);
  assert.match(launcherSource, /windowsPanelOpenLocked/);
  assert.match(launcherSource, /reuseExistingProcess: true/);
  assert.match(launcherSource, /openWindowsPanelViaBroker\(url\)/);
  assert.match(launcherSource, /windows-broker-started/);
  assert.match(windowsBrokerSource, /createServer/);
  assert.match(windowsBrokerSource, /dashi-taskboard-panel-/);
});
