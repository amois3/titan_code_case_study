// pageTypes.ts - the shapes the extracted page modules are written against.
//
// In the product these come from the browser layer: a CDP session manager, the
// frame contexts a snapshot was taken from, and one control as the model sees
// it. Only the parts the modules here actually touch are declared, so this
// repository stays runnable without Chrome, the extension, or the rest of the
// product.

/** The subset of the browser manager these modules call. */
export interface BrowserManager {
  /** Evaluate an expression in a tab and return its value. */
  evaluate(tabId: string, expression: string): Promise<unknown>;
  /** Send one DevTools Protocol command to a target. */
  run<T>(targetId: string, method: string, params: Record<string, unknown>): Promise<T>;
}

/** One document a snapshot could read: the tab's own, or a frame inside it. */
export interface FrameContext {
  frameId: string;
  /** The tab's own document, as opposed to anything embedded in it. */
  main?: boolean;
  /**
   * Where commands for this frame are sent.
   *
   * The tab, for a frame in the tab's own process. A cross-origin frame lives
   * in a process of its own and is addressed as a target in its own right.
   */
  runOn?: string;
  /** Short stable-per-snapshot prefix for the handles created in this frame. */
  key: string;
  url: string;
  contextId: number;
}

/** One control on the page, as the model is shown it. */
export interface SnapshotElement {
  /** Generation-safe handle: frame, snapshot, kind, number. */
  ref: string;
  role: string;
  name: string;
  tag: string;
  /** Nearest heading or labelled region, to tell same-named controls apart. */
  context?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  required?: boolean;
  offscreen?: boolean;
  /** Not visible on the page. Only file inputs are listed in this state. */
  hidden?: boolean;
  options?: string[];
  href?: string;
  /** Which frame it came from; only shown when a page has more than one. */
  frame?: string;
}
