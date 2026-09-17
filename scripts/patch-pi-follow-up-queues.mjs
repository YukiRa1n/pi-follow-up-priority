import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const QUEUE_IDENTITY_PATCH_SENTINEL = "pi-follow-up-priority:queue-identity-v1";
export const QUEUE_LEASE_PATCH_SENTINEL = "pi-follow-up-priority:queue-lease-v1";

const SESSION_FIELDS_VULNERABLE = `    /** Tracks pending follow-up messages for UI display. Removed when delivered. */
    _followUpMessages = [];
    /** Messages queued to be included with the next user prompt as context ("asides"). */`;

const SESSION_FIELDS_PATCHED = `    /** Tracks pending follow-up messages for UI display. Removed when delivered. */
    _followUpMessages = [];
    /** ${QUEUE_IDENTITY_PATCH_SENTINEL}: preserve queue kind for empty/duplicate text. */
    _queuedUserMessageKinds = new WeakMap();
    /** Messages queued to be included with the next user prompt as context ("asides"). */`;

const SESSION_EVENT_VULNERABLE = `        // When a user message starts, check if it's from either queue and remove it BEFORE emitting
        // This ensures the UI sees the updated queue state
        if (event.type === "message_start" && event.message.role === "user") {
            this._overflowRecoveryAttempted = false;
            const messageText = contentText(event.message.content, "");
            if (messageText) {
                // Check steering queue first
                const steeringIndex = this._steeringMessages.indexOf(messageText);
                if (steeringIndex !== -1) {
                    this._steeringMessages.splice(steeringIndex, 1);
                    this._emitQueueUpdate();
                }
                else {
                    // Check follow-up queue
                    const followUpIndex = this._followUpMessages.indexOf(messageText);
                    if (followUpIndex !== -1) {
                        this._followUpMessages.splice(followUpIndex, 1);
                        this._emitQueueUpdate();
                    }
                }
            }
        }`;

const SESSION_EVENT_PATCHED = `        // ${QUEUE_IDENTITY_PATCH_SENTINEL}: retire the exact queue kind, including image-only input.
        if (event.type === "message_start" && event.message.role === "user") {
            this._overflowRecoveryAttempted = false;
            const queuedKind = this._queuedUserMessageKinds.get(event.message);
            this._queuedUserMessageKinds.delete(event.message);
            const messageText = contentText(event.message.content, "");
            const queues = queuedKind === "steer"
                ? [this._steeringMessages]
                : queuedKind === "followUp"
                    ? [this._followUpMessages]
                    : [this._steeringMessages, this._followUpMessages];
            for (const queue of queues) {
                const index = queue.indexOf(messageText);
                if (index === -1)
                    continue;
                queue.splice(index, 1);
                this._emitQueueUpdate();
                break;
            }
        }`;

const SESSION_STEER_VULNERABLE = `        this.agent.steer({
            role: "user",
            content,
            timestamp: Date.now(),
        });`;

const SESSION_STEER_PATCHED = `        const message = {
            role: "user",
            content,
            timestamp: Date.now(),
        };
        this._queuedUserMessageKinds.set(message, "steer");
        this.agent.steer(message);`;

const SESSION_FOLLOW_UP_VULNERABLE = `        this.agent.followUp({
            role: "user",
            content,
            timestamp: Date.now(),
        });`;

const SESSION_FOLLOW_UP_PATCHED = `        const message = {
            role: "user",
            content,
            timestamp: Date.now(),
        };
        this._queuedUserMessageKinds.set(message, "followUp");
        this.agent.followUp(message);`;

const BUNDLED_SESSION_FIELDS_VULNERABLE = `_steeringMessages=[];_followUpMessages=[];_pendingNextTurnMessages=[];`;
const BUNDLED_SESSION_FIELDS_PATCHED = `_steeringMessages=[];_followUpMessages=[];/* ${QUEUE_IDENTITY_PATCH_SENTINEL} */_queuedUserMessageKinds=new WeakMap;_pendingNextTurnMessages=[];`;

const BUNDLED_SESSION_EVENT_VULNERABLE = `if(event.type==="message_start"&&event.message.role==="user"){this._overflowRecoveryAttempted=!1;let messageText=contentText(event.message.content,"");if(messageText){let steeringIndex=this._steeringMessages.indexOf(messageText);if(steeringIndex!==-1)this._steeringMessages.splice(steeringIndex,1),this._emitQueueUpdate();else{let followUpIndex=this._followUpMessages.indexOf(messageText);followUpIndex!==-1&&(this._followUpMessages.splice(followUpIndex,1),this._emitQueueUpdate())}}}`;
const BUNDLED_SESSION_EVENT_PATCHED = `if(event.type==="message_start"&&event.message.role==="user"){this._overflowRecoveryAttempted=!1;let queuedKind=this._queuedUserMessageKinds.get(event.message);this._queuedUserMessageKinds.delete(event.message);let messageText=contentText(event.message.content,""),queues=queuedKind==="steer"?[this._steeringMessages]:queuedKind==="followUp"?[this._followUpMessages]:[this._steeringMessages,this._followUpMessages];for(let queue of queues){let index=queue.indexOf(messageText);if(index===-1)continue;queue.splice(index,1),this._emitQueueUpdate();break}}`;

const BUNDLED_SESSION_STEER_VULNERABLE = `this.agent.steer({role:"user",content,timestamp:Date.now()})`;
const BUNDLED_SESSION_STEER_PATCHED = `(()=>{let message={role:"user",content,timestamp:Date.now()};this._queuedUserMessageKinds.set(message,"steer"),this.agent.steer(message)})()`;
const BUNDLED_SESSION_FOLLOW_UP_VULNERABLE = `this.agent.followUp({role:"user",content,timestamp:Date.now()})`;
const BUNDLED_SESSION_FOLLOW_UP_PATCHED = `(()=>{let message={role:"user",content,timestamp:Date.now()};this._queuedUserMessageKinds.set(message,"followUp"),this.agent.followUp(message)})()`;

const AGENT_QUEUE_VULNERABLE = `    hasItems() {
        return this.messages.length > 0;
    }
    drain() {`;

const AGENT_QUEUE_PATCHED = `    hasItems() {
        return this.messages.length > 0;
    }
    /** ${QUEUE_LEASE_PATCH_SENTINEL}: keep entries queued until transcript admission. */
    peek() {
        if (this.mode === "all") {
            return this.messages.slice();
        }
        const first = this.messages[0];
        return first ? [first] : [];
    }
    acknowledge(messages) {
        for (const message of messages) {
            const index = this.messages.indexOf(message);
            if (index !== -1) {
                this.messages.splice(index, 1);
            }
        }
    }
    drain() {`;

const AGENT_CONFIG_VULNERABLE = `            getSteeringMessages: async () => {
                if (skipInitialSteeringPoll) {
                    skipInitialSteeringPoll = false;
                    return [];
                }
                return this.steeringQueue.drain();
            },
            getFollowUpMessages: async () => this.followUpQueue.drain(),`;

const AGENT_CONFIG_PATCHED = `            getSteeringMessages: async () => {
                if (skipInitialSteeringPoll) {
                    skipInitialSteeringPoll = false;
                    return [];
                }
                return this.steeringQueue.peek();
            },
            getFollowUpMessages: async () => this.followUpQueue.peek(),
            acknowledgeSteeringMessages: async (messages) => this.steeringQueue.acknowledge(messages),
            acknowledgeFollowUpMessages: async (messages) => this.followUpQueue.acknowledge(messages),`;

const BUNDLED_AGENT_QUEUE_VULNERABLE = `hasItems(){return this.messages.length>0}drain(){`;
const BUNDLED_AGENT_QUEUE_PATCHED = `hasItems(){return this.messages.length>0}/* ${QUEUE_LEASE_PATCH_SENTINEL} */peek(){if(this.mode==="all")return this.messages.slice();let first=this.messages[0];return first?[first]:[]}acknowledge(messages){for(let message of messages){let index=this.messages.indexOf(message);index!==-1&&this.messages.splice(index,1)}}drain(){`;
const BUNDLED_AGENT_CONFIG_VULNERABLE = `getSteeringMessages:async()=>skipInitialSteeringPoll?(skipInitialSteeringPoll=!1,[]):this.steeringQueue.drain(),getFollowUpMessages:async()=>this.followUpQueue.drain()`;
const BUNDLED_AGENT_CONFIG_PATCHED = `getSteeringMessages:async()=>skipInitialSteeringPoll?(skipInitialSteeringPoll=!1,[]):this.steeringQueue.peek(),getFollowUpMessages:async()=>this.followUpQueue.peek(),acknowledgeSteeringMessages:async messages=>this.steeringQueue.acknowledge(messages),acknowledgeFollowUpMessages:async messages=>this.followUpQueue.acknowledge(messages)`;

const PATCHED_RUN_LOOP = `async function runLoop(initialContext, newMessages, initialConfig, signal, emit, streamFunction) {
    /* ${QUEUE_LEASE_PATCH_SENTINEL} */
    let currentContext = initialContext;
    let config = initialConfig;
    let lastCompletedTurn;
    let pendingSource = "steering";
    let pendingMessages = (await config.getSteeringMessages?.()) || [];
    const acknowledge = async (message) => {
        if (pendingSource === "followUp") {
            await config.acknowledgeFollowUpMessages?.([message]);
        }
        else {
            await config.acknowledgeSteeringMessages?.([message]);
        }
    };
    while (true) {
        let hasMoreToolCalls = true;
        while (hasMoreToolCalls || pendingMessages.length > 0) {
            if (lastCompletedTurn) {
                const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
                if (nextTurnSnapshot) {
                    currentContext = nextTurnSnapshot.context ?? currentContext;
                    config = {
                        ...config,
                        model: nextTurnSnapshot.model ?? config.model,
                        reasoning: nextTurnSnapshot.thinkingLevel === undefined
                            ? config.reasoning
                            : nextTurnSnapshot.thinkingLevel === "off"
                                ? undefined
                                : nextTurnSnapshot.thinkingLevel,
                    };
                }
                if (pendingMessages.length === 0) {
                    pendingSource = "steering";
                    pendingMessages = (await config.getSteeringMessages?.()) || [];
                }
                await emit({ type: "turn_start" });
            }
            if (pendingMessages.length > 0) {
                for (const message of pendingMessages) {
                    await emit({ type: "message_start", message });
                    await emit({ type: "message_end", message });
                    currentContext.messages.push(message);
                    newMessages.push(message);
                    await acknowledge(message);
                }
                pendingMessages = [];
            }
            const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
            newMessages.push(message);
            if (message.stopReason === "error" || message.stopReason === "aborted") {
                await emit({ type: "turn_end", message, toolResults: [] });
                await emit({ type: "agent_end", messages: newMessages });
                return;
            }
            const toolCalls = message.content.filter((c) => c.type === "toolCall");
            const toolResults = [];
            hasMoreToolCalls = false;
            if (toolCalls.length > 0) {
                const executedToolBatch = message.stopReason === "length"
                    ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
                    : await executeToolCalls(currentContext, message, config, signal, emit);
                toolResults.push(...executedToolBatch.messages);
                hasMoreToolCalls = !executedToolBatch.terminate;
                for (const result of toolResults) {
                    currentContext.messages.push(result);
                    newMessages.push(result);
                }
            }
            await emit({ type: "turn_end", message, toolResults });
            lastCompletedTurn = { message, toolResults, context: currentContext, newMessages };
            if (await config.shouldStopAfterTurn?.(lastCompletedTurn)) {
                await emit({ type: "agent_end", messages: newMessages });
                return;
            }
            pendingSource = "steering";
            pendingMessages = (await config.getSteeringMessages?.()) || [];
        }
        const followUpMessages = (await config.getFollowUpMessages?.()) || [];
        if (followUpMessages.length > 0) {
            pendingSource = "followUp";
            pendingMessages = followUpMessages;
            continue;
        }
        break;
    }
    await emit({ type: "agent_end", messages: newMessages });
}`;

function replaceExactly(input, vulnerable, patched, label) {
  const count = input.split(vulnerable).length - 1;
  if (count !== 1) throw new Error(`Unsupported Pi host: expected one ${label}, found ${count}`);
  return input.replace(vulnerable, patched);
}

function methodSlice(input, startAnchor, endAnchor, label) {
  const start = input.indexOf(startAnchor);
  if (start < 0 || input.indexOf(startAnchor, start + 1) >= 0) {
    throw new Error(`Unsupported Pi host: ${label} start is missing or ambiguous`);
  }
  const end = input.indexOf(endAnchor, start);
  if (end < 0) throw new Error(`Unsupported Pi host: ${label} end was not found`);
  return { start, end, source: input.slice(start, end) };
}

export function inspectAgentSessionQueueSource(input, { bundled = false } = {}) {
  if (input.includes(QUEUE_IDENTITY_PATCH_SENTINEL)) {
    const anchors = bundled
      ? ["_queuedUserMessageKinds=new WeakMap", 'queuedKind==="steer"', 'set(message,"followUp")']
      : ["_queuedUserMessageKinds = new WeakMap", 'queuedKind === "steer"', 'set(message, "followUp")'];
    return anchors.every((anchor) => input.includes(anchor)) ? "patched" : "unsupported";
  }
  const anchors = bundled
    ? [
        BUNDLED_SESSION_FIELDS_VULNERABLE,
        BUNDLED_SESSION_EVENT_VULNERABLE,
        BUNDLED_SESSION_STEER_VULNERABLE,
        BUNDLED_SESSION_FOLLOW_UP_VULNERABLE,
      ]
    : [SESSION_FIELDS_VULNERABLE, SESSION_EVENT_VULNERABLE, SESSION_STEER_VULNERABLE, SESSION_FOLLOW_UP_VULNERABLE];
  return anchors.every((anchor) => input.includes(anchor)) ? "vulnerable" : "unsupported";
}

export function patchAgentSessionQueueSource(input, { bundled = false } = {}) {
  const status = inspectAgentSessionQueueSource(input, { bundled });
  if (status === "patched") return { status: "already-patched", output: input };
  if (status !== "vulnerable") throw new Error("Unsupported Pi agent-session queue shape");
  let output = input;
  if (bundled) {
    output = replaceExactly(
      output,
      BUNDLED_SESSION_FIELDS_VULNERABLE,
      BUNDLED_SESSION_FIELDS_PATCHED,
      "bundled session fields",
    );
    output = replaceExactly(
      output,
      BUNDLED_SESSION_EVENT_VULNERABLE,
      BUNDLED_SESSION_EVENT_PATCHED,
      "bundled session event",
    );
    output = replaceExactly(
      output,
      BUNDLED_SESSION_STEER_VULNERABLE,
      BUNDLED_SESSION_STEER_PATCHED,
      "bundled session steer",
    );
    output = replaceExactly(
      output,
      BUNDLED_SESSION_FOLLOW_UP_VULNERABLE,
      BUNDLED_SESSION_FOLLOW_UP_PATCHED,
      "bundled session follow-up",
    );
  } else {
    output = replaceExactly(output, SESSION_FIELDS_VULNERABLE, SESSION_FIELDS_PATCHED, "session fields");
    output = replaceExactly(output, SESSION_EVENT_VULNERABLE, SESSION_EVENT_PATCHED, "session event");
    output = replaceExactly(output, SESSION_STEER_VULNERABLE, SESSION_STEER_PATCHED, "session steer");
    output = replaceExactly(output, SESSION_FOLLOW_UP_VULNERABLE, SESSION_FOLLOW_UP_PATCHED, "session follow-up");
  }
  return { status: "patched", output };
}

export function inspectAgentQueueSource(input, { bundled = false } = {}) {
  if (input.includes(QUEUE_LEASE_PATCH_SENTINEL)) {
    const anchors = bundled
      ? ["peek(){", "acknowledge(messages){", "steeringQueue.peek()", "acknowledgeFollowUpMessages"]
      : ["peek() {", "acknowledge(messages) {", "steeringQueue.peek()", "acknowledgeFollowUpMessages"];
    return anchors.every((anchor) => input.includes(anchor)) ? "patched" : "unsupported";
  }
  const anchors = bundled
    ? [BUNDLED_AGENT_QUEUE_VULNERABLE, BUNDLED_AGENT_CONFIG_VULNERABLE]
    : [AGENT_QUEUE_VULNERABLE, AGENT_CONFIG_VULNERABLE];
  return anchors.every((anchor) => input.includes(anchor)) ? "vulnerable" : "unsupported";
}

export function patchAgentQueueSource(input, { bundled = false } = {}) {
  const status = inspectAgentQueueSource(input, { bundled });
  if (status === "patched") return { status: "already-patched", output: input };
  if (status !== "vulnerable") throw new Error("Unsupported Pi agent queue shape");
  let output = input;
  if (bundled) {
    output = replaceExactly(output, BUNDLED_AGENT_QUEUE_VULNERABLE, BUNDLED_AGENT_QUEUE_PATCHED, "bundled agent queue");
    output = replaceExactly(
      output,
      BUNDLED_AGENT_CONFIG_VULNERABLE,
      BUNDLED_AGENT_CONFIG_PATCHED,
      "bundled agent config",
    );
  } else {
    output = replaceExactly(output, AGENT_QUEUE_VULNERABLE, AGENT_QUEUE_PATCHED, "agent queue");
    output = replaceExactly(output, AGENT_CONFIG_VULNERABLE, AGENT_CONFIG_PATCHED, "agent config");
  }
  return { status: "patched", output };
}

export function inspectAgentLoopQueueSource(input, { bundled = false } = {}) {
  const { source } = methodSlice(
    input,
    "async function runLoop(",
    "async function streamAssistantResponse(",
    "agent loop",
  );
  if (source.includes(QUEUE_LEASE_PATCH_SENTINEL)) {
    return source.includes("acknowledgeSteeringMessages") && source.includes("acknowledgeFollowUpMessages")
      ? "patched"
      : "unsupported";
  }
  const anchors = bundled
    ? [
        "pendingMessages=await config.getSteeringMessages?.()||[]",
        "nextTurnSnapshot=await config.prepareNextTurn?.(lastCompletedTurn)",
        "pendingMessages=followUpMessages",
      ]
    : [
        "pendingMessages = (await config.getSteeringMessages?.()) || []",
        "const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn)",
        "pendingMessages = followUpMessages",
      ];
  return anchors.every((anchor) => source.includes(anchor)) ? "vulnerable" : "unsupported";
}

export function patchAgentLoopQueueSource(input, { bundled = false } = {}) {
  const status = inspectAgentLoopQueueSource(input, { bundled });
  if (status === "patched") return { status: "already-patched", output: input };
  if (status !== "vulnerable") throw new Error("Unsupported Pi agent-loop queue shape");
  const { start, end } = methodSlice(
    input,
    "async function runLoop(",
    "async function streamAssistantResponse(",
    "agent loop",
  );
  return { status: "patched", output: input.slice(0, start) + PATCHED_RUN_LOOP + input.slice(end) };
}

function walkJavaScriptFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

export function discoverPiFollowUpQueueTargets(packageRoot) {
  const root = resolve(packageRoot);
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error(`Pi package.json not found: ${packageJsonPath}`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== "@earendil-works/pi-coding-agent" || !/^0\.85\./.test(String(packageJson.version))) {
    throw new Error(
      `Unsupported Pi package ${packageJson.name ?? "unknown"}@${packageJson.version ?? "unknown"}; expected @earendil-works/pi-coding-agent 0.85.x`,
    );
  }
  const agentCoreRoot = join(root, "node_modules", "@earendil-works", "pi-agent-core");
  const agentCorePackage = JSON.parse(readFileSync(join(agentCoreRoot, "package.json"), "utf8"));
  if (!/^0\.85\./.test(String(agentCorePackage.version))) {
    throw new Error(`Unsupported pi-agent-core ${agentCorePackage.version}; expected 0.85.x`);
  }
  const session = join(root, "dist", "core", "agent-session.js");
  const agent = join(agentCoreRoot, "dist", "agent.js");
  const loop = join(agentCoreRoot, "dist", "agent-loop.js");
  for (const path of [session, agent, loop]) {
    if (!existsSync(path)) throw new Error(`Pi queue host file not found: ${path}`);
  }
  const bundles = walkJavaScriptFiles(join(root, "dist", "bundle", "chunks")).filter((path) => {
    const source = readFileSync(path, "utf8");
    return source.includes(BUNDLED_SESSION_FIELDS_VULNERABLE) || source.includes(QUEUE_IDENTITY_PATCH_SENTINEL);
  });
  if (bundles.length !== 1) throw new Error(`Expected exactly one bundled Pi queue host, found ${bundles.length}`);
  return [
    { path: session, kinds: ["session"], bundled: false },
    { path: agent, kinds: ["agent"], bundled: false },
    { path: loop, kinds: ["loop"], bundled: false },
    { path: bundles[0], kinds: ["session", "agent", "loop"], bundled: true },
  ];
}

function inspectTarget(input, target) {
  const statuses = target.kinds.map((kind) =>
    kind === "session"
      ? inspectAgentSessionQueueSource(input, { bundled: target.bundled })
      : kind === "agent"
        ? inspectAgentQueueSource(input, { bundled: target.bundled })
        : inspectAgentLoopQueueSource(input, { bundled: target.bundled }),
  );
  if (statuses.every((status) => status === "patched")) return "patched";
  if (statuses.every((status) => status === "vulnerable")) return "vulnerable";
  return "unsupported";
}

function patchTarget(input, target) {
  let output = input;
  let changed = false;
  for (const kind of target.kinds) {
    const result =
      kind === "session"
        ? patchAgentSessionQueueSource(output, { bundled: target.bundled })
        : kind === "agent"
          ? patchAgentQueueSource(output, { bundled: target.bundled })
          : patchAgentLoopQueueSource(output, { bundled: target.bundled });
    output = result.output;
    changed ||= result.status === "patched";
  }
  return { status: changed ? "patched" : "already-patched", output };
}

export function patchPiFollowUpQueueFiles(targets, { check = false } = {}) {
  const plans = targets.map((target) => {
    const path = resolve(target.path);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Pi queue host file not found: ${path}`);
    const input = readFileSync(path, "utf8");
    if (check) return { ...target, path, status: inspectTarget(input, target), input, output: input };
    return { ...target, path, input, ...patchTarget(input, target) };
  });
  if (check) return plans.map(({ path, status }) => ({ path, status }));

  const written = [];
  try {
    for (const plan of plans) {
      if (plan.status !== "patched") continue;
      const baseBackup = `${plan.path}.follow-up-queue-original`;
      let backup = baseBackup;
      if (existsSync(baseBackup) && readFileSync(baseBackup, "utf8") !== plan.input) {
        const digest = createHash("sha256").update(plan.input).digest("hex").slice(0, 12);
        backup = `${baseBackup}.${digest}`;
        if (existsSync(backup) && readFileSync(backup, "utf8") !== plan.input) {
          throw new Error(`Backup hash collision for ${plan.path}`);
        }
      }
      if (!existsSync(backup)) copyFileSync(plan.path, backup);
      writeFileSync(plan.path, plan.output, "utf8");
      written.push({ path: plan.path, backup });
    }
  } catch (error) {
    for (const item of written.reverse()) copyFileSync(item.backup, item.path);
    throw error;
  }
  return plans.map(({ path, status }) => ({ path, status }));
}

function globalPiPackageRoot() {
  const globalRoot =
    process.platform === "win32"
      ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm root -g"], {
          encoding: "utf8",
          windowsHide: true,
        }).trim()
      : execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  return join(globalRoot, "@earendil-works", "pi-coding-agent");
}

function parseArguments(argv) {
  let check = false;
  let packageRoot;
  let useGlobal = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--check") check = true;
    else if (arg === "--global") useGlobal = true;
    else if (arg === "--package-root") {
      packageRoot = argv[++index];
      if (!packageRoot) throw new Error("--package-root requires a path");
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (Number(useGlobal) + Number(Boolean(packageRoot)) !== 1) {
    throw new Error("Use exactly one target form: --global or --package-root <path>");
  }
  return { check, packageRoot: useGlobal ? globalPiPackageRoot() : packageRoot };
}

function isMainModule() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    const { check, packageRoot } = parseArguments(process.argv.slice(2));
    const targets = discoverPiFollowUpQueueTargets(packageRoot);
    const results = patchPiFollowUpQueueFiles(targets, { check });
    for (const result of results) console.log(`${result.status}: ${result.path}`);
    if (check && results.some(({ status }) => status !== "patched")) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
