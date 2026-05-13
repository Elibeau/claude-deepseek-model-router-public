import { configFromEnv, handleRequest } from "./router-core.js";

export default {
  async fetch(request, env) {
    return handleRequest(request, configFromEnv(env));
  }
};
