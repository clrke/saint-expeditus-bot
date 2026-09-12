module.exports = {
  apps: [
    {
      name: 'bridge',
      cwd: __dirname,
      script: 'npm',
      args: 'start --prefix bridge-server',
      kill_timeout: 65000,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'discord-bot',
      cwd: __dirname,
      script: 'npm',
      args: 'start --prefix discord-bot',
      kill_timeout: 65000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
