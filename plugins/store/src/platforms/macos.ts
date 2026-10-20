/**
 * The node:fs implementation both platforms share. This module is the platform boundary that the
 * plugin build replaces with a stub in browser bundles, which keeps node:fs out of the WebView.
 */
export { dispose, initialize } from "#store/platforms/node-store";
