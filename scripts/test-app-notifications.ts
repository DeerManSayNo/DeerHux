import assert from "node:assert/strict";
import {
  appNotificationNames,
  notifyApp,
  subscribeToAppNotification,
} from "../lib/app-notifications.ts";

const target = new EventTarget();
const received: string[] = [];

const stopRoles = subscribeToAppNotification("deerhux.roles-updated", () => {
  received.push("deerhux.roles-updated");
}, target);
const stopModels = subscribeToAppNotification("deerhux.models-updated", () => {
  received.push("deerhux.models-updated");
}, target);

assert.deepEqual(appNotificationNames, {
  rolesUpdated: "deerhux.roles-updated",
  modelsUpdated: "deerhux.models-updated",
});

notifyApp("deerhux.roles-updated", target);
notifyApp("deerhux.models-updated", target);
assert.deepEqual(received, ["deerhux.roles-updated", "deerhux.models-updated"]);

stopRoles();
stopRoles();
notifyApp("deerhux.roles-updated", target);
notifyApp("deerhux.models-updated", target);
assert.deepEqual(received, [
  "deerhux.roles-updated",
  "deerhux.models-updated",
  "deerhux.models-updated",
]);

stopModels();
notifyApp("deerhux.models-updated", target);
assert.equal(received.length, 3);

console.log("app notification tests passed");
