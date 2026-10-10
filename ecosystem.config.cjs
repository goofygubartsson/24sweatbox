// pm2 process file for the Sweatbox API.
//   pnpm install && pnpm build
//   pm2 start ecosystem.config.cjs && pm2 save
// Secrets come from .env in this folder (see .env.example); everything else from sweatbox.config.ts.
module.exports = {
  apps: [
    {
      name: "sweatbox",
      cwd: __dirname,
      script: "apps/server/dist/index.js",
      node_args: "--enable-source-maps",
      env: { NODE_ENV: "production" },
      // one process: sessions live in memory
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "512M",
      kill_timeout: 5000,
      time: true,
    },
  ],
};
