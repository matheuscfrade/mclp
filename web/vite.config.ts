import path from "node:path";

const externalNodeModules = process.env.MCLP_NODE_MODULES;
const moduleRoot = externalNodeModules || path.resolve(__dirname, "node_modules");

function modulePath(name: string) {
  return path.join(moduleRoot, name);
}

export default {
  resolve: {
    alias: {
      react: modulePath("react"),
      "react-dom": modulePath("react-dom"),
      "react/jsx-runtime": path.join(moduleRoot, "react", "jsx-runtime.js"),
      leaflet: modulePath("leaflet"),
      "leaflet/dist/leaflet.css": path.join(moduleRoot, "leaflet", "dist", "leaflet.css"),
      "react-leaflet": modulePath("react-leaflet"),
    },
  },
};
