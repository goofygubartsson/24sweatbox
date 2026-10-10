import type { SweatboxConfig } from "./schema";

/**
 * The part of the config the browser is allowed to see. Discord ids, ports, bind host, CORS, file
 * paths and rate limits stay on the server.
 */
export function toPublicConfig(c: SweatboxConfig) {
  return {
    app: {
      name: c.app.name,
      shortName: c.app.shortName,
      publicUrl: c.app.publicUrl,
      apiBase: c.app.apiBase,
      wsPath: c.app.wsPath,
    },
    session: {
      codeLength: c.session.codeLength,
      idleTimeoutSec: c.session.idleTimeoutSec,
      endedRetentionSec: c.session.endedRetentionSec,
      minSpeed: c.session.minSpeed,
      maxSpeed: c.session.maxSpeed,
      maxScriptBytes: c.session.maxScriptBytes,
      logLimit: c.session.logLimit,
      pingIntervalSec: c.session.pingIntervalSec,
      trailPoints: c.session.trailPoints,
    },
    auth: { reauthBannerText: c.auth.reauthBannerText },
    sim: c.sim,
    ground: c.ground,
    circuit: c.circuit,
    twr: c.twr,
    colours: c.colours,
    ui: c.ui,
    generator: c.generator,
    limits: { stripValueMax: c.limits.stripValueMax },
    data: { scenarioMetaRegex: c.data.scenarioMetaRegex },
    features: c.features,
  };
}

export type PublicConfig = ReturnType<typeof toPublicConfig>;
