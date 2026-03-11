/**
 * PWA entry point — renders the same React app as the VS Code webview,
 * but with the standalone CSS theme and PWA transport (WebSocket).
 */

import React from "react";
import { createRoot } from "react-dom/client";
import "../webview/theme-standalone.css";
import "../webview/styles.css";
import { App } from "../webview/App";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
