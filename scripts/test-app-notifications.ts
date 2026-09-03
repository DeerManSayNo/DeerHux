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
const stopProjectFiles = subscribeToAppNotification("deerhux.project-files-updated", () => {
  received.push("deerhux.project-files-updated");
}, target);

assert.deepEqual(appNotificationNames, {
  rolesUpdated: "deerhux.roles-updated",
  modelsUpdated: "deerhux.models-updated",
  projectFilesUpdated: "deerhux.project-files-updated",
});

notifyApp("deerhux.roles-updated", target);
notifyApp("deerhux.models-updated", target);
notifyApp("deerhux.project-files-updated", target);
assert.deepEqual(received, [
  "deerhux.roles-updated",
  "deerhux.models-updated",
  "deerhux.project-files-updated",
]);

stopRoles();
stopRoles();
notifyApp("deerhux.roles-updated", target);
notifyApp("deerhux.models-updated", target);
assert.deepEqual(received, [
  "deerhux.roles-updated",
  "deerhux.models-updated",
  "deerhux.project-files-updated",
  "deerhux.models-updated",
]);

stopModels();
notifyApp("deerhux.models-updated", target);
assert.equal(received.length, 4);

stopProjectFiles();
notifyApp("deerhux.project-files-updated", target);
assert.equal(received.length, 4);

console.log("app notification tests passed");
