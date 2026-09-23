import fs from "node:fs";
import path from "node:path";

export function createRoleRunStore(runsRoot) {
  const ensureDirectory = (directory) => fs.mkdirSync(directory, { recursive: true });
  const append = (file, value) => fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
  const eventsPath = (runId) => path.join(runsRoot, runId, "events.jsonl");

  return {
    runsRoot,
    createRun(manifest, event) {
      const runDir = path.join(runsRoot, manifest.run_id);
      ensureDirectory(runDir);
      fs.writeFileSync(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      append(eventsPath(manifest.run_id), event);
    },
    appendEvent(runId, event) {
      const file = eventsPath(runId);
      if (!fs.existsSync(file)) throw new Error(`run not found: ${runId}`);
      append(file, event);
    },
    readEvents({ provider = undefined, role = undefined, model = undefined } = {}) {
      if (!fs.existsSync(runsRoot)) return [];
      return fs.readdirSync(runsRoot).flatMap((runId) => {
        const file = eventsPath(runId);
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      }).filter((event) => (provider === undefined || event.provider === provider)
        && (role === undefined || event.role === role)
        && (model === undefined || event.model === model));
    }
  };
}
