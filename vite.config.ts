import pluginChecker from "vite-plugin-checker";
import { defineConfig } from "vite";

export default defineConfig({
    base: "/Flappy-Bird/",
    plugins: [pluginChecker({ typescript: true, overlay: false })],
});
