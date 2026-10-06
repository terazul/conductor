/**
 * Putting text on the clipboard (Amendment 83).
 *
 * The browser only allows it on a secure page: localhost, 127.0.0.1 and https all are,
 * a LAN address is not. Where it can't, this throws, and the caller says so.
 */

export async function copyText(text: string): Promise<void> {
  const clipboard = (globalThis as { navigator?: Navigator }).navigator?.clipboard;
  if (!clipboard?.writeText) throw new Error("This page can't use the clipboard. Open Conductor on localhost.");
  await clipboard.writeText(text);
}
