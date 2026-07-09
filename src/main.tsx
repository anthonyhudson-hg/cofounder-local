import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { NotificationWindow } from "./components/NotificationWindow";

// The notification popup is a second Tauri window loading this same bundle with a
// query param, so it renders a minimal card instead of the whole app.
const isNotificationWindow = new URLSearchParams(window.location.search).get("window") === "notification";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isNotificationWindow ? <NotificationWindow /> : <App />}</React.StrictMode>,
);
