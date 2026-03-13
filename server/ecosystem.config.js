// PM2 config — run with: pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'mbeam-server',
    script: 'index.js',
    env: {
      PORT: 3000,
      BASE_DOMAIN: 'magun.cloud',
    },
    restart_delay: 2000,
    max_restarts: 10,
  }],
};
