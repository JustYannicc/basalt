import { createRoot } from "react-dom/client";
import { NativeDevice } from "./native-device.tsx";

const root = document.getElementById("root");
if (root) createRoot(root).render(<NativeDevice />);
