import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as model from "../cc-dispatch/mods/cc-dispatch/model.js";

function inertNode() {
  const target = { nodeId: null };
  const proxy = new Proxy(target, {
    get: (value, key) => key === "nodeId" ? value.nodeId : (...args) => {
      if (key === "id") value.nodeId = args[0];
      return proxy;
    },
  });
  return proxy;
}

// Evaluate the production view with inert UI primitives; no Herdr app or hc.
const source = readFileSync(
  new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url),
  "utf8",
).replace(/^import .*;\n/gm, "")
  .replace("export default class Dispatch", "class Dispatch");
const context = vm.createContext({
  ...model, View: class {}, h_flex: inertNode, svg: inertNode,
});
vm.runInContext(`${source}\nglobalThis.TopicView = Dispatch;`, context);
const view = new context.TopicView();
const colors = { ansi1: "red", accent: "blue", foreground: "white", background: "black" };

function queuedTopic(tasks = {}, items = []) {
  return model.buildTopics([], {
    queued: {
      topic: { id: "queued", tasks, owner: { terminal: "t1" } },
      backlog: { items },
    },
  })[0];
}

const request = {
  id: "r1", type: "dispatch", target: "owner", delivered_at: null,
};

test("a bound active Task still offers whole-Topic controls", () => {
  const topic = queuedTopic({ k1: { run: "dev-active", kind: "dev" } });
  assert.deepEqual(
    Array.from(view.topicControlButtons(colors, topic), (node) => node.nodeId),
    ["pause-queued", "stop-queued"],
  );
});

test("queued dispatches must offer whole-Topic pause and stop", () => {
  const topic = queuedTopic({ k1: { run: null, kind: "dev", request } });
  assert.equal(topic.tasks[0].group, "queued");
  assert.deepEqual(
    Array.from(view.topicControlButtons(colors, topic), (node) => node.nodeId),
    ["pause-queued", "stop-queued"],
    "The owner can become idle before delivery; the queued Topic needs pause/stop.",
  );
});

test("backlog refinement alone must offer whole-Topic pause and stop", () => {
  const topic = queuedTopic({}, [{
    id: "b1", text: "Refine this", status: "refining",
    request: { ...request, type: "refine" },
  }]);
  assert.deepEqual(
    Array.from(view.topicControlButtons(colors, topic), (node) => node.nodeId),
    ["pause-queued", "stop-queued"],
    "An unbound Topic still has an automatic delivery queue to pause or cancel.",
  );
});
