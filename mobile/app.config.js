module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    gitCommit: (process.env.EAS_BUILD_GIT_COMMIT_HASH || '').slice(0, 7) || 'dev',
  },
});
