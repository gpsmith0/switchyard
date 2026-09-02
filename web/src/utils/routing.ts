/** Hash-based routing utilities for the Switchyard app. */

export function navigateTo(route: string): void {
  window.location.hash = route;
}
