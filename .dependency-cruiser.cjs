module.exports = {
  forbidden: [
    {
      name: 'no-substrate-to-pipeline',
      severity: 'error',
      from: { path: '^packages/core/src/(transport|config|identity|stores|providers|bounded-execution|events)/' },
      to:   { path: '^packages/core/src/(intake|escalation|lifecycle|review|reporting|tool-surface)/' },
    },
    {
      name: 'no-pipeline-to-tools',
      severity: 'error',
      from: { path: '^packages/core/src/(intake|escalation|lifecycle|review|reporting)/' },
      to:   { path: '^packages/core/src/tools/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
      dependencyTypes: ['npm'],
    },
    includeOnly: '^packages/(core|server)/src/',
  },
};
