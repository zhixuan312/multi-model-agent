export const SEVERITY_LADDER = [
  'Severity (your judgment, calibrated to actual impact):',
  '- critical: must fix first — RCE, data loss, auth bypass, build broken, data corruption.',
  '- high:     real bug or security gap; blocks release.',
  '- medium:   real issue; fix soon; not blocking.',
  '- low:      minor or cosmetic issue; nice-to-fix.',
  'Calibrate to actual impact, not how alarming the wording sounds. Workers commonly inflate — resist the urge.',
].join('\n');
