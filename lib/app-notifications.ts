export const appNotificationNames = {
  rolesUpdated: "deerhux.roles-updated",
  modelsUpdated: "deerhux.models-updated",
} as const;

export type AppNotificationName = (typeof appNotificationNames)[keyof typeof appNotificationNames];

type AppNotificationTarget = Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">;
type AppNotificationListener = () => void;

function defaultTarget(): AppNotificationTarget {
  return window;
}

/** Dispatch a same-window application notification. */
export function notifyApp(name: AppNotificationName, target: AppNotificationTarget = defaultTarget()): void {
  target.dispatchEvent(new Event(name));
}

/** Subscribe to a same-window application notification and return its cleanup. */
export function subscribeToAppNotification(
  name: AppNotificationName,
  listener: AppNotificationListener,
  target: AppNotificationTarget = defaultTarget(),
): () => void {
  const handler: EventListener = () => listener();
  target.addEventListener(name, handler);

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    target.removeEventListener(name, handler);
  };
}
