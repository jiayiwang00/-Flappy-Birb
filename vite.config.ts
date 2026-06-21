import pluginChecker from "vite-plugin-checker";
import { defineConfig } from "vite";

export default defineConfig({
    base: "/-Flappy-Birb/",
    plugins: [pluginChecker({ typescript: true, overlay: false })],
});
