import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  discoverPiFollowUpQueueTargets,
  inspectAgentLoopQueueSource,
  inspectAgentQueueSource,
  inspectAgentSessionQueueSource,
  patchAgentLoopQueueSource,
  patchAgentQueueSource,
  patchAgentSessionQueueSource,
  patchPiFollowUpQueueFiles,
} from "../scripts/patch-pi-follow-up-queues.mjs";

const fixtureRoot = resolve("node_modules/@earendil-works/pi-coding-agent");
const fixtureCoreRoot = join(fixtureRoot, "node_modules", "@earendil-works", "pi-agent-core");
const sessionPath = join(fixtureRoot, "dist", "core", "agent-session.js");
const agentPath = join(fixtureCoreRoot, "dist", "agent.js");
const loopPath = join(fixtureCoreRoot, "dist", "agent-loop.js");

function onlyBundle(root = fixtureRoot): string {
  const chunks = join(root, "dist", "bundle", "chunks");
  const targets = discoverPiFollowUpQueueTargets(root).filter((target) => target.bundled);
  assert.equal(targets.length, 1);
  assert.equal(dirname(targets[0].path), chunks);
  return targets[0].path;
}

test("queue patches recognize and idempotently transform Pi 0.85.1 source shapes", () => {
  const session = readFileSync(sessionPath, "utf8");
  const agent = readFileSync(agentPath, "utf8");
  const loop = readFileSync(loopPath, "utf8");
  const bundle = readFileSync(onlyBundle(), "utf8");

  assert.equal(inspectAgentSessionQueueSource(session), "vulnerable");
  assert.equal(inspectAgentQueueSource(agent), "vulnerable");
  assert.equal(inspectAgentLoopQueueSource(loop), "vulnerable");
  assert.equal(inspectAgentSessionQueueSource(bundle, { bundled: true }), "vulnerable");
  assert.equal(inspectAgentQueueSource(bundle, { bundled: true }), "vulnerable");
  assert.equal(inspectAgentLoopQueueSource(bundle, { bundled: true }), "vulnerable");

  const patchedSession = patchAgentSessionQueueSource(session).output;
  const patchedAgent = patchAgentQueueSource(agent).output;
  const patchedLoop = patchAgentLoopQueueSource(loop).output;
  const patchedBundle = patchAgentLoopQueueSource(
    patchAgentQueueSource(patchAgentSessionQueueSource(bundle, { bundled: true }).output, { bundled: true }).output,
    { bundled: true },
  ).output;

  assert.equal(inspectAgentSessionQueueSource(patchedSession), "patched");
  assert.equal(inspectAgentQueueSource(patchedAgent), "patched");
  assert.equal(inspectAgentLoopQueueSource(patchedLoop), "patched");
  assert.equal(inspectAgentSessionQueueSource(patchedBundle, { bundled: true }), "patched");
  assert.equal(inspectAgentQueueSource(patchedBundle, { bundled: true }), "patched");
  assert.equal(inspectAgentLoopQueueSource(patchedBundle, { bundled: true }), "patched");
  assert.equal(patchAgentSessionQueueSource(patchedSession).status, "already-patched");
  assert.equal(patchAgentQueueSource(patchedAgent).status, "already-patched");
  assert.equal(patchAgentLoopQueueSource(patchedLoop).status, "already-patched");
});

function copyFixtureFile(root: string, source: string, relative: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}

test("package discovery patches every importable and bundled queue host with backups", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-follow-up-queue-package-"));
  try {
    copyFixtureFile(root, join(fixtureRoot, "package.json"), "package.json");
    copyFixtureFile(root, sessionPath, join("dist", "core", "agent-session.js"));
    copyFixtureFile(
      root,
      join(fixtureCoreRoot, "package.json"),
      join("node_modules", "@earendil-works", "pi-agent-core", "package.json"),
    );
    copyFixtureFile(root, agentPath, join("node_modules", "@earendil-works", "pi-agent-core", "dist", "agent.js"));
    copyFixtureFile(root, loopPath, join("node_modules", "@earendil-works", "pi-agent-core", "dist", "agent-loop.js"));
    const bundleName = onlyBundle().split(/[\\/]/).at(-1);
    assert.ok(bundleName);
    copyFixtureFile(root, onlyBundle(), join("dist", "bundle", "chunks", bundleName));

    const targets = discoverPiFollowUpQueueTargets(root);
    assert.equal(targets.length, 4);
    assert.ok(
      patchPiFollowUpQueueFiles(targets, { check: true }).every(
        ({ status }: { status: string }) => status === "vulnerable",
      ),
    );
    assert.ok(patchPiFollowUpQueueFiles(targets).every(({ status }: { status: string }) => status === "patched"));
    assert.ok(targets.every(({ path }) => existsSync(`${path}.follow-up-queue-original`)));
    assert.ok(
      patchPiFollowUpQueueFiles(targets, { check: true }).every(
        ({ status }: { status: string }) => status === "patched",
      ),
    );
    assert.ok(
      patchPiFollowUpQueueFiles(targets).every(({ status }: { status: string }) => status === "already-patched"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function loadPatchedAgent(): Promise<{ Agent: any; root: string }> {
  const parent = join(fixtureRoot, "node_modules", "@earendil-works");
  const root = mkdtempSync(join(parent, "pi-agent-core-follow-up-test-"));
  cpSync(join(fixtureCoreRoot, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(fixtureCoreRoot, "package.json"), join(root, "package.json"));
  writeFileSync(join(root, "dist", "agent.js"), patchAgentQueueSource(readFileSync(agentPath, "utf8")).output);
  writeFileSync(join(root, "dist", "agent-loop.js"), patchAgentLoopQueueSource(readFileSync(loopPath, "utf8")).output);
  const module = await import(`${pathToFileURL(join(root, "dist", "agent.js")).href}?test=${Date.now()}`);
  return { Agent: module.Agent, root };
}

test("leased steer and follow-up entries survive preparation and awaited-listener failures", async () => {
  const { Agent, root } = await loadPatchedAgent();
  try {
    for (const variant of ["prepare", "listener"] as const) {
      for (const kind of ["steer", "followUp"] as const) {
        const payload = `${variant}-${kind}-must-survive`;
        const core = createFauxCore({
          provider: "queue-test",
          models: [{ id: "faux", contextWindow: 128000, maxTokens: 1024 }],
        });
        core.setResponses([
          fauxAssistantMessage("turn one"),
          fauxAssistantMessage("recovery one"),
          fauxAssistantMessage("recovery two"),
        ]);
        let agent: any;
        let providerCalls = 0;
        const streamFn = (model: any, context: any, options: any) => {
          providerCalls++;
          if (providerCalls === 1) {
            const message = {
              role: "user",
              content: [{ type: "text", text: payload }],
              timestamp: Date.now(),
            };
            if (kind === "steer") agent.steer(message);
            else agent.followUp(message);
          }
          return core.streamSimple(model, context, options);
        };
        agent = new Agent({
          streamFn,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          initialState: {
            model: core.getModel("faux"),
            systemPrompt: "",
            messages: [],
            tools: [],
            thinkingLevel: "off",
          },
          ...(variant === "prepare"
            ? {
                prepareNextTurn: async () => {
                  throw new Error("simulated next-turn preparation failure");
                },
              }
            : {}),
        });
        let completedTurn = false;
        const unsubscribe = agent.subscribe(async (event: any) => {
          if (event.type === "turn_end") completedTurn = true;
          if (variant === "listener" && event.type === "turn_start" && completedTurn) {
            throw new Error("simulated awaited listener failure");
          }
        });

        await agent.prompt("start");
        assert.equal(agent.hasQueuedMessages(), true, `${variant}/${kind} remains leased after failure`);
        assert.equal(
          agent.state.messages.some((message: any) => JSON.stringify(message.content ?? "").includes(payload)),
          false,
        );

        unsubscribe();
        agent.prepareNextTurn = undefined;
        await agent.prompt("resume");
        const occurrences = agent.state.messages.filter((message: any) =>
          JSON.stringify(message.content ?? "").includes(payload),
        ).length;
        assert.equal(occurrences, 1, `${variant}/${kind} is admitted exactly once on recovery`);
        assert.equal(agent.hasQueuedMessages(), false, `${variant}/${kind} lease is acknowledged after admission`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
