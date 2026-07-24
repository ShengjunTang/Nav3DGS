import { createRoot } from "react-dom/client";
import Home from "../app/page";
import "../app/globals.css";

window.__gaussNavStage = "mounting-react";
createRoot(document.getElementById("root")!).render(
  <Home />,
);
window.__gaussNavStage = "react-mounted";
